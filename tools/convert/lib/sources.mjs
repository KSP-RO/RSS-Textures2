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

const SOURCE_REPO = 'KSP-RO/RSS-Textures-Source';

/** Everything published on a source release, indexed by body. */
export async function listRelease(tag = 'latest', repo = SOURCE_REPO) {
  const url = tag === 'latest'
    ? 'https://api.github.com/repos/' + repo + '/releases/latest'
    : 'https://api.github.com/repos/' + repo + '/releases/tags/' + tag;
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('GitHub API ' + res.status + ' for ' + url);
  const release = await res.json();

  const byBody = new Map();
  for (const asset of release.assets) {
    // RSS-Textures-src-<Body>.zip
    const m = asset.name.match(/^RSS-Textures-src-(.+)\.zip$/i);
    if (!m) continue;
    byBody.set(m[1], {
      body: m[1],
      asset: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      id: asset.id,
    });
  }
  return { tag: release.tag_name, bodies: byBody };
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

/** Index a downloaded source zip: map filename stem to an extractable entry. */
export async function indexZip(path) {
  const buf = await readFile(path);
  const entries = parseCentralDirectory(buf).filter((e) => !e.name.endsWith('/'));
  const byMap = new Map();
  for (const e of entries) {
    const base = e.name.split('/').pop();
    const stem = base.replace(/\.[^.]+$/, '');
    byMap.set(stem, e);
  }
  return { buf, entries, byMap };
}

/**
 * Resolve which source file backs a given map.
 *
 * The source zips are named per body and their contents already follow the
 * manifest's naming, so "MimasColor" is RSS-Textures-src-Mimas.zip ->
 * RSS-Textures-src-Mimas/MimasColor.png. Returns null when the body or the
 * map is not in this release - the source set is deliberately partial.
 */
export function resolveMap(index, mapName) {
  return index.byMap.get(mapName) ?? null;
}

export { SOURCE_REPO };
