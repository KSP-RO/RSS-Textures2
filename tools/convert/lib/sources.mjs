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

const GH = { accept: 'application/vnd.github+json' };

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
    const res = await fetch(url, { headers: GH });
    if (!res.ok) throw new Error('GitHub API ' + res.status + ' for ' + url);
    return res.json();
  }

  const latest = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', { headers: GH });
  if (latest.ok) return latest.json();
  if (latest.status !== 404) {
    throw new Error('GitHub API ' + latest.status + ' for the latest release of ' + repo);
  }

  const url = 'https://api.github.com/repos/' + repo + '/releases?per_page=30';
  const res = await fetch(url, { headers: GH });
  if (!res.ok) throw new Error('GitHub API ' + res.status + ' for ' + url);
  const all = (await res.json()).filter((r) => !r.draft);
  if (!all.length) throw new Error(repo + ' has published no releases');
  return all[0];
}

/** Everything published on a source release, indexed by body. */
export async function listRelease(tag = 'latest', repo = SOURCE_REPO) {
  const release = await fetchRelease(tag, repo);

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
