// DDS header reading and size arithmetic.
//
// Derived from the DDS spec:
//   https://learn.microsoft.com/en-us/windows/win32/direct3ddds/dds-header
// The header is 128 bytes (4 magic + 124 DDS_HEADER); DX10 files add 20 more.

import { open } from 'node:fs/promises';

export const HEADER_BYTES = 128;

const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC      = 0x4;
const DDPF_RGB         = 0x40;
const DDPF_LUMINANCE   = 0x20000;

// Bytes per 4x4 block for the block-compressed formats we ship.
const BLOCK_BYTES = { DXT1: 8, DXT3: 16, DXT5: 16 };

// Bytes per pixel for the uncompressed formats we ship.
const PIXEL_BYTES = { A8B8G8R8: 4, A8R8G8B8: 4, R16: 2, R8: 1 };

export function isBlockCompressed(format) {
  return Object.hasOwn(BLOCK_BYTES, format);
}

/** Bytes occupied by a single mip level of `format` at w x h. */
export function levelBytes(format, w, h) {
  if (isBlockCompressed(format)) {
    return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * BLOCK_BYTES[format];
  }
  const bpp = PIXEL_BYTES[format];
  if (bpp === undefined) throw new Error('unknown format: ' + format);
  return Math.max(1, w) * Math.max(1, h) * bpp;
}

/** Number of levels in a complete mip chain down to 1x1. */
export function fullChainLevels(w, h) {
  return Math.floor(Math.log2(Math.max(w, h))) + 1;
}

/**
 * Total payload bytes for `levels` mip levels starting at w x h.
 * `levels` of 0 or 1 both mean "base level only" - DDS uses them
 * interchangeably and both appear in this repo.
 */
export function chainBytes(format, w, h, levels) {
  let total = 0;
  for (let i = 0; i < Math.max(1, levels); i++) {
    const lw = Math.max(1, w >> i);
    const lh = Math.max(1, h >> i);
    total += levelBytes(format, lw, lh);
    if (lw === 1 && lh === 1) break;
  }
  return total;
}

/** Expected on-disk size of a DDS file with this geometry. */
export function expectedFileSize(format, w, h, levels) {
  return HEADER_BYTES + chainBytes(format, w, h, levels);
}

/**
 * Identify a texture from its size alone, for files we can only see through a
 * zip central directory. Returns null when the size matches nothing, or is
 * ambiguous between candidates.
 */
export function identifyBySize(bytes, candidates) {
  const hits = candidates.filter(
    (c) => expectedFileSize(c.format, c.width, c.height, c.levels) === bytes,
  );
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Which pixel formats each kind of map is allowed to use.
 *
 * This is what makes size-based identification unambiguous. A 134,217,856 byte
 * file is both "DXT5 16384x8192 without mips" and "A8B8G8R8 8192x4096 without
 * mips"; knowing it is a colour map and not a biome map settles it.
 *
 * DXT entries under Height are legacy: five outer-moon heightmaps store
 * elevation in DXT colour channels. They are listed so the scanner can see
 * them, not because they are a good idea.
 */
export const FORMATS_BY_KIND = {
  Color:   ['DXT1', 'DXT5'],
  Surface: ['DXT1', 'DXT5'],
  Ring:    ['DXT1', 'DXT5'],
  _NRM:    ['DXT5', 'DXT1'],
  Height:  ['R16', 'R8', 'DXT5', 'DXT1'],
  Biomes:  ['A8B8G8R8', 'A8R8G8B8'],
};

const ALL_FORMATS = ['DXT1', 'DXT5', 'R16', 'R8', 'A8B8G8R8'];

/**
 * Every geometry we could plausibly be looking at, for identifyBySize.
 * Equirectangular maps in this pack are always 2:1.
 */
export function candidateGeometries(maxSize = 16384, kind = null) {
  const formats = (kind && FORMATS_BY_KIND[kind]) || ALL_FORMATS;
  const out = [];
  for (let w = 64; w <= maxSize; w *= 2) {
    const h = w / 2;
    for (const format of formats) {
      out.push({ format, width: w, height: h, levels: 1, mips: 'none' });
      out.push({ format, width: w, height: h, levels: fullChainLevels(w, h), mips: 'full' });
    }
  }
  return out;
}

function decodePixelFormat(b) {
  const flags = b.readUInt32LE(80);
  const fourcc = b.toString('ascii', 84, 88);
  const bits = b.readUInt32LE(88);
  const rMask = b.readUInt32LE(92);
  const gMask = b.readUInt32LE(96);
  const bMask = b.readUInt32LE(100);
  const aMask = b.readUInt32LE(104);

  if (flags & DDPF_FOURCC) {
    if (fourcc === 'DX10') {
      return { format: 'DX10', dxgi: b.length >= 148 ? b.readUInt32LE(128) : null };
    }
    return { format: fourcc };
  }
  if (flags & DDPF_RGB) {
    const alpha = Boolean(flags & DDPF_ALPHAPIXELS) && aMask !== 0;
    if (bits === 32 && rMask === 0x000000ff && gMask === 0x0000ff00 && bMask === 0x00ff0000) {
      return { format: 'A8B8G8R8', hasAlphaChannel: alpha };
    }
    if (bits === 32 && rMask === 0x00ff0000 && gMask === 0x0000ff00 && bMask === 0x000000ff) {
      return { format: 'A8R8G8B8', hasAlphaChannel: alpha };
    }
    if (bits === 16 && rMask === 0x0000ffff) return { format: 'R16' };
    if (bits === 8 && rMask === 0x000000ff) return { format: 'R8' };
  }
  if (flags & DDPF_LUMINANCE) {
    if (bits === 16) return { format: 'R16' };
    if (bits === 8) return { format: 'R8' };
  }
  return {
    format: 'UNKNOWN(flags=0x' + flags.toString(16) + ',bits=' + bits + ',r=0x' + rMask.toString(16) + ')',
  };
}

/** Read and decode a DDS header. Returns null if the file is not a DDS. */
export async function readHeader(path) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(148);
    const { bytesRead } = await fh.read(buf, 0, 148, 0);
    if (bytesRead < HEADER_BYTES || buf.toString('ascii', 0, 4) !== 'DDS ') return null;
    const stat = await fh.stat();
    const height = buf.readUInt32LE(12);
    const width = buf.readUInt32LE(16);
    const declaredLevels = buf.readUInt32LE(28);
    const pf = decodePixelFormat(buf.subarray(0, bytesRead));
    const levels = Math.max(1, declaredLevels);
    const known = !pf.format.startsWith('UNKNOWN') && pf.format !== 'DX10';
    return {
      width,
      height,
      declaredLevels,
      levels,
      mips: levels > 1 ? 'full' : 'none',
      ...pf,
      bytes: stat.size,
      expectedBytes: known ? expectedFileSize(pf.format, width, height, levels) : null,
    };
  } finally {
    await fh.close();
  }
}

/**
 * Scan the alpha channel of the base mip of a DXT5 texture.
 *
 * DXT5 stores alpha as two 8-bit endpoints plus 3-bit indices in the first
 * 8 bytes of each 16-byte block. If both endpoints are 255 in every block the
 * alpha channel is uniformly opaque, and the texture is paying double: DXT1
 * carries the same colour data at half the size.
 */
export async function dxt5AlphaIsOpaque(path, width, height) {
  const baseBytes = levelBytes('DXT5', width, height);
  const fh = await open(path, 'r');
  try {
    const CHUNK = 8 << 20; // multiple of 16, so blocks never straddle reads
    const buf = Buffer.alloc(CHUNK);
    let offset = HEADER_BYTES;
    let remaining = baseBytes;
    while (remaining > 0) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, remaining), offset);
      if (bytesRead === 0) break;
      for (let i = 0; i + 16 <= bytesRead; i += 16) {
        if (buf[i] !== 255 || buf[i + 1] !== 255) return false;
      }
      offset += bytesRead;
      remaining -= bytesRead;
    }
    return true;
  } finally {
    await fh.close();
  }
}

/**
 * Classify the RGB filler convention of a DXT5nm normal map.
 *
 * Unity's UnpackNormal reads x from alpha and y from green, ignoring red and
 * blue entirely. Encoders differ in what they leave there: some write white
 * (1,y,1,x), others replicate y (y,y,y,x). Both decode identically, but the
 * difference fingerprints which tool produced the file.
 */
export async function dxt5nmFiller(path, width, height, sampleBlocks = 4000) {
  const totalBlocks = levelBytes('DXT5', width, height) / 16;
  const stride = Math.max(1, Math.floor(totalBlocks / sampleBlocks));
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    let white = 0, replicated = 0, n = 0;
    for (let blk = 0; blk < totalBlocks; blk += stride) {
      const { bytesRead } = await fh.read(buf, 0, 16, HEADER_BYTES + blk * 16);
      if (bytesRead < 16) break;
      for (const off of [8, 10]) {
        const c = buf.readUInt16LE(off);
        const r = (c >> 11) & 0x1f;
        const g = (c >> 5) & 0x3f;
        const bl = c & 0x1f;
        n++;
        if (r === 31 && bl === 31) white++;
        else if (r === (g >> 1) && bl === (g >> 1)) replicated++;
      }
    }
    if (n === 0) return 'unknown';
    if (white / n > 0.9) return 'white';           // (1, y, 1, x)
    if (replicated / n > 0.9) return 'replicated'; // (y, y, y, x)
    return 'mixed';
  } finally {
    await fh.close();
  }
}
