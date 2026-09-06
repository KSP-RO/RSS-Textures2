// Read a zip's central directory without reading the whole archive.
//
// The 17 largest textures in the 16384 pack exceed GitHub's 100 MiB file limit
// and so exist only inside the published release zip. Their geometry can still
// be recovered, because a DDS file's size uniquely determines its format,
// dimensions and mip count (see dds.mjs identifyBySize). This module fetches
// just the tail of a release asset over HTTP range requests - a few hundred KB
// instead of two gigabytes.

import { readFile } from 'node:fs/promises';

const CDFH_SIGNATURE = 0x02014b50; // "PK\x01\x02"
const TAIL_BYTES = 512 * 1024;

/** Fetch the last `bytes` of a URL using a Range request. */
async function fetchTail(url, bytes) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!head.ok) throw new Error('HEAD ' + url + ' failed: ' + head.status);
  const total = Number(head.headers.get('content-length'));
  if (!Number.isFinite(total) || total <= 0) throw new Error('no content-length for ' + url);
  const start = Math.max(0, total - bytes);
  const res = await fetch(url, { headers: { Range: 'bytes=' + start + '-' }, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error('range GET failed: ' + res.status);
  return { buf: Buffer.from(await res.arrayBuffer()), total };
}

/**
 * Parse every central directory file header found in `buf`.
 *
 * We scan for signatures rather than seeking from the end-of-central-directory
 * record, because the tail we fetched may start mid-directory. Entries whose
 * name does not decode cleanly are skipped as false-positive signature matches.
 */
export function parseCentralDirectory(buf) {
  const entries = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== CDFH_SIGNATURE) continue;
    const compressedSize = buf.readUInt32LE(i + 20);
    const uncompressedSize = buf.readUInt32LE(i + 24);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    if (nameLen === 0 || nameLen > 4096 || i + 46 + nameLen > buf.length) continue;
    const name = buf.toString('utf8', i + 46, i + 46 + nameLen);
    if (!/^[\w\-./ ()+]+$/.test(name)) continue;
    entries.push({ name, compressedSize, uncompressedSize });
    i += 45 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read the central directory of a local zip file or a remote URL. */
export async function readZipDirectory(source, { tailBytes = TAIL_BYTES } = {}) {
  if (/^https?:\/\//i.test(source)) {
    const { buf, total } = await fetchTail(source, tailBytes);
    return { entries: parseCentralDirectory(buf), archiveBytes: total };
  }
  const buf = await readFile(source);
  return { entries: parseCentralDirectory(buf), archiveBytes: buf.length };
}

/** Resolve the browser_download_url of a release asset by name. */
export async function findReleaseAsset(repo, tag, assetName) {
  const url = tag === 'latest'
    ? 'https://api.github.com/repos/' + repo + '/releases/latest'
    : 'https://api.github.com/repos/' + repo + '/releases/tags/' + tag;
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('GitHub API ' + res.status + ' for ' + url);
  const release = await res.json();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      'asset ' + assetName + ' not in release ' + release.tag_name +
      ' (have: ' + release.assets.map((a) => a.name).join(', ') + ')',
    );
  }
  return { url: asset.browser_download_url, size: asset.size, tag: release.tag_name };
}
