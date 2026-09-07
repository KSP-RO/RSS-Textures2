// Reading and writing DDS files, level by level.
//
// The size arithmetic lives in tools/manifest/lib/dds.mjs and is shared, so a
// file this writes is measured by exactly the code that verifies it.
//
// Header conventions in the existing pack are not consistent - three different
// ones are in use, from three eras of tooling. Rather than reproduce whichever
// one a given file happens to have, this writes a single canonical form
// following the Microsoft spec:
//
//   uncompressed      DDSD_PITCH,       dwPitchOrLinearSize = bytes per row
//   block compressed  DDSD_LINEARSIZE,  dwPitchOrLinearSize = bytes in level 0
//
// which is what the DXT files and the R16 heightmaps already do. Payload bytes
// round-trip exactly; headers are normalised.

import { open, writeFile } from 'node:fs/promises';
import {
  HEADER_BYTES, levelBytes, chainBytes, fullChainLevels, isBlockCompressed,
} from '../../manifest/lib/dds.mjs';

// dwFlags
const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PITCH = 0x8;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDSD_LINEARSIZE = 0x80000;

// dwCaps
const DDSCAPS_COMPLEX = 0x8;
const DDSCAPS_MIPMAP = 0x400000;
const DDSCAPS_TEXTURE = 0x1000;

// ddspf.dwFlags
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;

/** Pixel-format block for each format we emit. */
function pixelFormat(format) {
  switch (format) {
    case 'DXT1':
    case 'DXT5':
      return { flags: DDPF_FOURCC, fourCC: format, bits: 0, r: 0, g: 0, b: 0, a: 0 };
    // Byte order matters and is easy to get backwards. The biome maps are
    // A8B8G8R8 (red in the low byte), NOT the more common A8R8G8B8. Swapping
    // these masks silently permutes every biome in the game.
    case 'A8B8G8R8':
      return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, fourCC: null, bits: 32,
        r: 0x000000ff, g: 0x0000ff00, b: 0x00ff0000, a: 0xff000000 };
    case 'A8R8G8B8':
      return { flags: DDPF_RGB | DDPF_ALPHAPIXELS, fourCC: null, bits: 32,
        r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: 0xff000000 };
    case 'R16':
      return { flags: DDPF_LUMINANCE, fourCC: null, bits: 16, r: 0x0000ffff, g: 0, b: 0, a: 0 };
    case 'R8':
      return { flags: DDPF_LUMINANCE, fourCC: null, bits: 8, r: 0x000000ff, g: 0, b: 0, a: 0 };
    default:
      throw new Error('cannot write format: ' + format);
  }
}

/** Bytes per row of the base level, for the DDSD_PITCH convention. */
function pitchOf(format, width) {
  const bitsPerPixel = { A8B8G8R8: 32, A8R8G8B8: 32, R16: 16, R8: 8 }[format];
  return ((width * bitsPerPixel) + 7) >> 3;
}

export function buildHeader({ format, width, height, levels }) {
  const b = Buffer.alloc(HEADER_BYTES);
  const pf = pixelFormat(format);
  const compressed = isBlockCompressed(format);
  const hasMips = levels > 1;

  b.write('DDS ', 0, 'ascii');
  b.writeUInt32LE(124, 4);                       // dwSize: header minus magic
  b.writeUInt32LE(
    DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT |
    (compressed ? DDSD_LINEARSIZE : DDSD_PITCH) |
    (hasMips ? DDSD_MIPMAPCOUNT : 0), 8);
  b.writeUInt32LE(height, 12);
  b.writeUInt32LE(width, 16);
  b.writeUInt32LE(compressed ? levelBytes(format, width, height) : pitchOf(format, width), 20);
  b.writeUInt32LE(0, 24);                        // dwDepth: unused for 2D
  b.writeUInt32LE(hasMips ? levels : 0, 28);     // 0 means "no chain"
  // dwReserved1[11] stays zero. Some tools stamp a signature here; we do not,
  // because a rebuild must be byte-identical to the previous one.
  b.writeUInt32LE(32, 76);                       // ddspf.dwSize
  b.writeUInt32LE(pf.flags, 80);
  if (pf.fourCC) b.write(pf.fourCC, 84, 'ascii');
  b.writeUInt32LE(pf.bits, 88);
  b.writeUInt32LE(pf.r, 92);
  b.writeUInt32LE(pf.g, 96);
  b.writeUInt32LE(pf.b, 100);
  b.writeUInt32LE(pf.a, 104);
  b.writeUInt32LE(DDSCAPS_TEXTURE | (hasMips ? DDSCAPS_COMPLEX | DDSCAPS_MIPMAP : 0), 108);
  return b;
}

/** Dimensions of each mip level, largest first. */
export function levelGeometry(width, height, levels) {
  const out = [];
  for (let i = 0; i < levels; i++) {
    out.push({ level: i, width: Math.max(1, width >> i), height: Math.max(1, height >> i) });
  }
  return out;
}

/**
 * Write a DDS. `levelData` is an array of Buffers, largest mip first; its
 * length must equal `levels`.
 */
export async function writeDDS(path, { format, width, height, levels }, levelData) {
  if (levelData.length !== levels) {
    throw new Error(path + ': got ' + levelData.length + ' level(s), header declares ' + levels);
  }
  const geom = levelGeometry(width, height, levels);
  for (let i = 0; i < levels; i++) {
    const want = levelBytes(format, geom[i].width, geom[i].height);
    if (levelData[i].length !== want) {
      throw new Error(
        path + ' level ' + i + ' (' + geom[i].width + 'x' + geom[i].height + '): ' +
        levelData[i].length + ' bytes, expected ' + want);
    }
  }
  await writeFile(path, Buffer.concat([buildHeader({ format, width, height, levels }), ...levelData]));
}

/**
 * Read the mip levels out of a DDS as raw Buffers, without decoding them.
 * Used to round-trip payloads and to feed already-encoded blocks back out.
 */
export async function readLevels(path, { format, width, height, levels }) {
  const fh = await open(path, 'r');
  try {
    const total = chainBytes(format, width, height, levels);
    const buf = Buffer.alloc(total);
    const { bytesRead } = await fh.read(buf, 0, total, HEADER_BYTES);
    if (bytesRead !== total) {
      throw new Error(path + ': read ' + bytesRead + ' payload bytes, expected ' + total);
    }
    const out = [];
    let off = 0;
    for (const g of levelGeometry(width, height, levels)) {
      const n = levelBytes(format, g.width, g.height);
      out.push(buf.subarray(off, off + n));
      off += n;
    }
    return out;
  } finally {
    await fh.close();
  }
}

export { fullChainLevels, levelBytes };
