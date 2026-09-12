// Fetching source assets from the RSS-Textures-Source releases.
//
// Sources live outside this repository because they are larger than what
// belongs in git: 5.7 GiB of PNG across 34 files in v0.0.1, and that is a
// partial set. They are published as one zip per body on a release, so a build
// pulls only the bodies it needs and release bandwidth is free.
//
// Assets are cached by asset id and size. A release asset is immutable in
// practice, so a cached file is reused without re-checking the network.

import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parseCentralDirectory } from '../../manifest/lib/zip.mjs';
import { normalizeMapName } from '../../manifest/lib/mapname.mjs';

const SOURCE_REPO = 'KSP-RO/RSS-Textures-Source';

/**
 * Headers for an api.github.com request.
 *
 * Unauthenticated API access is 60 requests an hour *per source IP*, and
 * GitHub-hosted runners leave through shared NAT per Azure region - so a
 * handful of jobs anywhere in that region can exhaust it and every later
 * request comes back 403. That is what killed one set of a three-set release
 * while the other two, on runners elsewhere, sailed through.
 *
 * A token raises it to 1000 an hour for the repository. GITHUB_TOKEN is
 * enough: a token grants API read access to any public repository, so the one
 * minted for this repo can read the sources repo's releases.
 */
function ghHeaders() {
  const h = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) h.authorization = 'Bearer ' + token;
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the API said, rather than a bare status code. */
async function describe(res, url) {
  let detail = '';
  try {
    const body = await res.json();
    if (body?.message) detail = ': ' + body.message;
  } catch { /* not JSON; the status is all we have */ }

  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const mins = Number.isFinite(reset) ? Math.max(0, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
    detail += '\nRate limit exhausted' + (mins === null ? '' : ', resets in ~' + mins + ' min') + '.' +
      (process.env.GITHUB_TOKEN || process.env.GH_TOKEN
        ? ''
        : '\nNo GITHUB_TOKEN/GH_TOKEN in the environment, so this request was' +
          ' unauthenticated: 60/hour shared with every other runner on this IP.');
  }
  return 'GitHub API ' + res.status + ' for ' + url + detail;
}

/**
 * GET from the API, retrying the failures that are worth retrying.
 *
 * 403 and 429 are rate limiting, 5xx is GitHub having a moment; both are
 * transient and both otherwise fail a multi-gigabyte build at its first step.
 * A rate limit that resets further out than the cap is not worth sleeping
 * through - report it instead.
 */
async function ghFetch(url, { attempts = 3, maxWaitMs = 30000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { headers: ghHeaders() });
    if (res.ok || res.status === 404) return res;
    last = res;
    if (![403, 429, 500, 502, 503, 504].includes(res.status)) break;
    if (i === attempts - 1) break;

    // Precedence matters, and the smallest wait is the wrong choice: an
    // exhausted rate limit does not clear in two seconds, so backing off
    // exponentially against one just burns the remaining attempts and buries
    // the real reason. Take what the server said, and only invent a delay when
    // it said nothing.
    const retryAfter = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    let wait;
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      wait = retryAfter * 1000;
    } else if (res.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
      wait = reset * 1000 - Date.now();
    } else {
      wait = 2000 * 2 ** i;
    }
    if (!(wait > 0) || wait > maxWaitMs) break;
    console.log('  GitHub API ' + res.status + ', retrying in ' + Math.ceil(wait / 1000) + 's');
    await sleep(wait);
  }
  return last;
}

/**
 * Resolve a tag to a release.
 *
 * "latest" is the default because no tag is pinned anywhere: a build takes
 * whatever the sources repo published most recently. GitHub's /releases/latest
 * ignores prereleases and 404s when every release is one, which is a plausible
 * state for a repository still finding its footing - so fall back to the
 * newest non-draft release rather than failing.
 */
async function fetchRelease(tag, repo) {
  if (tag && tag !== 'latest') {
    const url = 'https://api.github.com/repos/' + repo + '/releases/tags/' + tag;
    const res = await ghFetch(url);
    if (!res.ok) throw new Error(await describe(res, url));
    return res.json();
  }

  const latestUrl = 'https://api.github.com/repos/' + repo + '/releases/latest';
  const latest = await ghFetch(latestUrl);
  if (latest.ok) return latest.json();
  if (latest.status !== 404) throw new Error(await describe(latest, latestUrl));

  const url = 'https://api.github.com/repos/' + repo + '/releases?per_page=30';
  const res = await ghFetch(url);
  if (!res.ok) throw new Error(await describe(res, url));
  const all = (await res.json()).filter((r) => !r.draft);
  if (!all.length) throw new Error(repo + ' has published no releases');
  return all[0];
}

/** Where a resolved release index is remembered, next to the assets it describes. */
function indexPath(cacheDir, repo, tag) {
  return join(cacheDir, 'release-' + repo.replace(/[^A-Za-z0-9._-]/g, '-') + '-' + tag + '.json');
}

/**
 * The release index, from the cache directory if it is already there.
 *
 * A build with a fully warm asset cache should not need the network at all,
 * and until this existed it did: every job called the API purely to map a body
 * name onto an asset id it already had on disk. One rate-limited request then
 * failed a build that had everything it needed locally.
 *
 * Only for an explicit tag. "latest" means "whatever is newest", which is a
 * question that has to be asked rather than remembered.
 */
async function cachedRelease(tag, repo, cacheDir) {
  if (!cacheDir || !tag || tag === 'latest') return null;
  try {
    return JSON.parse(await readFile(indexPath(cacheDir, repo, tag), 'utf8'));
  } catch {
    return null;
  }
}

/** Everything published on a source release, indexed by body. */
export async function listRelease(tag = 'latest', repo = SOURCE_REPO, { cacheDir = null } = {}) {
  const release = (await cachedRelease(tag, repo, cacheDir)) ?? await fetchRelease(tag, repo);

  // Remember it under the tag it resolved to, so a "latest" run that later
  // becomes an explicit --sources run finds it too.
  if (cacheDir && release.tag_name) {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(indexPath(cacheDir, repo, release.tag_name), JSON.stringify(release));
    } catch { /* the cache is an optimisation; a build without it still works */ }
  }

  const byBody = new Map();
  const byName = new Map();
  const shadowed = [];

  // Body zips are named <Body>.zip. Earlier releases used
  // RSS-Textures-src-<Body>.zip, and v0.0.1 carries both: 28 plain, 13
  // prefixed, 11 bodies under both names with different contents. Where both
  // exist the plain name wins - it is the current scheme, and the difference
  // is real rather than cosmetic (Earth.zip holds five maps, the prefixed one
  // holds a single colour map). The prefixed form is still read because Triton
  // and Venus are published only that way.
  const claim = (body, entry, legacy) => {
    const key = body.toLowerCase();
    const prior = byBody.get(key);
    if (prior) {
      // Plain beats prefixed regardless of which arrived first.
      const loser = prior.legacy ? prior : { ...entry, body, legacy };
      const winner = prior.legacy ? { ...entry, body, legacy } : prior;
      shadowed.push({ body, used: winner.asset, ignored: loser.asset });
      byBody.set(key, winner);
      return;
    }
    byBody.set(key, { body, legacy, ...entry });
  };

  for (const asset of release.assets) {
    const entry = {
      asset: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      id: asset.id,
    };
    // Every asset by its own name, so things that are not per-body texture
    // zips can be found too - raw DEMs, in particular, which heights.mjs
    // looks up by the name the manifest's `dems` entry declares.
    byName.set(asset.name, entry);

    const prefixed = asset.name.match(/^RSS-Textures-src-(.+)\.zip$/i);
    if (prefixed) { claim(prefixed[1], entry, true); continue; }
    const plain = asset.name.match(/^(.+)\.zip$/i);
    if (plain) claim(plain[1], entry, false);
  }
  return { tag: release.tag_name, bodies: byBody, assets: byName, shadowed };
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** Download an asset into the cache, or return the cached copy. */
export async function fetchAsset(entry, cacheDir) {
  await mkdir(cacheDir, { recursive: true });
  const path = join(cacheDir, entry.id + '-' + entry.asset);
  if (await exists(path)) {
    const s = await stat(path);
    if (s.size === entry.size) return { path, cached: true };
  }
  const res = await fetch(entry.url, { redirect: 'follow' });
  if (!res.ok) throw new Error('download failed ' + res.status + ' for ' + entry.url);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  const s = await stat(path);
  if (s.size !== entry.size) {
    throw new Error(entry.asset + ': downloaded ' + s.size + ' bytes, expected ' + entry.size);
  }
  return { path, cached: false };
}

/**
 * Read one file out of a zip.
 *
 * Only stored (0) and deflate (8) are handled, which is everything a normal
 * zip writer produces. The local file header has to be re-read because its
 * extra field length can differ from the central directory's.
 */
export function extractEntry(zipBuf, entry) {
  const sig = zipBuf.readUInt32LE(entry.localHeaderOffset);
  if (sig !== 0x04034b50) {
    throw new Error(entry.name + ': bad local header signature at ' + entry.localHeaderOffset);
  }
  const method = zipBuf.readUInt16LE(entry.localHeaderOffset + 8);
  const nameLen = zipBuf.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLen = zipBuf.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const raw = zipBuf.subarray(start, start + entry.compressedSize);

  if (method === 0) return Buffer.from(raw);
  if (method === 8) return inflateRawSync(raw);
  throw new Error(entry.name + ': unsupported compression method ' + method);
}

/**
 * Index a downloaded source zip.
 *
 * Keys are normalized (case-folded, underscores removed) so that a file named
 * EarthColor.png, Earth_Color.png or earth_color.png all answer to the same
 * lookup. Source assets are hand-authored by several people; requiring one
 * exact spelling makes a file silently invisible, which is indistinguishable
 * from it not having been added yet.
 *
 * `stem` on each entry keeps the spelling the file actually used, so reports
 * name the real file rather than a normalized ghost of it.
 */
export async function indexZip(path) {
  const buf = await readFile(path);
  const entries = parseCentralDirectory(buf).filter((e) => !e.name.endsWith('/'));
  const byMap = new Map();
  const collisions = [];

  for (const e of entries) {
    const base = e.name.split('/').pop();
    const stem = base.replace(/\.[^.]+$/, '');
    const key = normalizeMapName(stem);
    const prior = byMap.get(key);
    if (prior) {
      // Two spellings of one name in the same archive. Silently keeping one
      // would make which texture ships depend on zip ordering.
      collisions.push({ key, names: [prior.stem, stem] });
      continue;
    }
    byMap.set(key, { ...e, stem });
  }

  if (collisions.length) {
    throw new Error(
      path + ': ' + collisions.length + ' name collision(s) after case and underscore folding:\n' +
      collisions.map((c) => '  ' + c.names.join('  and  ') + '  both mean "' + c.key + '"').join('\n') +
      '\nRemove or rename one of each pair.');
  }
  return { buf, entries, byMap };
}

/**
 * Resolve which source file backs a given map.
 *
 * The source zips are named per body and their contents follow the manifest's
 * naming, so "MimasColor" is RSS-Textures-src-Mimas.zip ->
 * RSS-Textures-src-Mimas/MimasColor.png — or Mimas_Color.png, which resolves
 * the same way. Returns null when the body or the map is not in this release;
 * the source set is deliberately partial.
 */
export function resolveMap(index, mapName) {
  return index.byMap.get(normalizeMapName(mapName)) ?? null;
}

export { SOURCE_REPO };
