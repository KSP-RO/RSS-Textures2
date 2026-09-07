// PNG decoding.
//
// Node ships zlib, and PNG is a thin container around a zlib stream, so this
// needs no dependency. Written rather than shelling out to vips or
// Compressonator because the source assets are the one thing the build must
// never silently misread: a heightmap quietly downconverted from 16 bit to
// 8 bit still looks like a heightmap, and would flatten terrain to 256 steps
// without any error.
//
// Supports colour types 0/2/3/4/6 at bit depths 8 and 16 (and 1/2/4 for
// palette and greyscale). Adam7 interlacing is rejected rather than
// mishandled - nothing in the source set uses it.

import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const COLOUR_NAME = {
  0: 'greyscale', 2: 'rgb', 3: 'palette', 4: 'greyscale+alpha', 6: 'rgba',
};

/** Read IHDR only. Cheap: needs the first 33 bytes. */
export function readInfo(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('first chunk is not IHDR');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colourType = buf[25];
  const interlace = buf[28];
  return {
    width, height, bitDepth, colourType,
    colour: COLOUR_NAME[colourType] ?? ('type' + colourType),
    channels: CHANNELS[colourType],
    interlace,
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Undo the per-scanline filters, in place, one row at a time.
 * `bpp` is the byte distance to the pixel on the left, minimum 1.
 */
function unfilter(raw, width, height, bpp, rowBytes) {
  const out = Buffer.alloc(height * rowBytes);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    raw.copy(cur, 0, rp, rp + rowBytes);
    rp += rowBytes;
    const prev = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;

    switch (filter) {
      case 0: break;
      case 1:
        for (let i = bpp; i < rowBytes; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
        break;
      case 2:
        if (prev) for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= bpp ? cur[i - bpp] : 0;
          const up = prev ? prev[i] : 0;
          cur[i] = (cur[i] + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= bpp ? cur[i - bpp] : 0;
          const up = prev ? prev[i] : 0;
          const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
          cur[i] = (cur[i] + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error('unknown scanline filter ' + filter + ' on row ' + y);
    }
  }
  return out;
}

/**
 * Decode a PNG.
 *
 * Returns { width, height, bitDepth, colourType, channels, samples } where
 * samples is a Uint8Array for 8-bit input and a Uint16Array for 16-bit,
 * interleaved by channel. 16-bit input keeps full precision - that is the
 * whole reason for decoding here rather than handing the file to a tool that
 * would normalise it to 8.
 */
export function decode(buf) {
  const info = readInfo(buf);
  if (info.interlace !== 0) {
    throw new Error('Adam7 interlaced PNG is not supported (re-export without interlacing)');
  }
  if (!CHANNELS[info.colourType]) throw new Error('unsupported colour type ' + info.colourType);

  const idat = [];
  let palette = null;
  let transparency = null;

  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (idat.length === 0) throw new Error('no IDAT chunks');

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height, bitDepth, colourType, channels } = info;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));

  const expected = height * (rowBytes + 1);
  if (raw.length < expected) {
    throw new Error('IDAT is short: ' + raw.length + ' bytes, expected ' + expected);
  }
  const flat = unfilter(raw, width, height, bpp, rowBytes);

  if (bitDepth === 16) {
    const samples = new Uint16Array(width * height * channels);
    for (let i = 0; i < samples.length; i++) samples[i] = flat.readUInt16BE(i * 2);
    return { ...info, samples, palette, transparency };
  }
  if (bitDepth === 8) {
    const samples = new Uint8Array(width * height * channels);
    flat.copy(samples, 0, 0, samples.length);
    return { ...info, samples, palette, transparency };
  }
  // Sub-byte depths: only ever seen on palette and greyscale images.
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  const samples = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * channels; x++) {
      const byte = flat[y * rowBytes + Math.floor(x / perByte)];
      const shift = 8 - bitDepth * ((x % perByte) + 1);
      samples[y * width * channels + x] = (byte >> shift) & mask;
    }
  }
  return { ...info, samples, palette, transparency };
}

/**
 * Convert a decoded PNG to RGBA8.
 *
 * 16-bit input is truncated to the high byte here, which is correct for colour
 * and normal maps and wrong for heightmaps - use toGrey16 for those.
 */
export function toRGBA8(img) {
  const { width, height, colourType, channels, samples, palette, bitDepth } = img;
  const n = width * height;
  const out = new Uint8Array(n * 4);
  const to8 = bitDepth === 16 ? (v) => v >> 8 : (v) => v;

  for (let i = 0; i < n; i++) {
    const s = i * channels;
    const o = i * 4;
    switch (colourType) {
      case 0: // greyscale
        out[o] = out[o + 1] = out[o + 2] = to8(samples[s]);
        out[o + 3] = 255;
        break;
      case 2: // rgb
        out[o] = to8(samples[s]);
        out[o + 1] = to8(samples[s + 1]);
        out[o + 2] = to8(samples[s + 2]);
        out[o + 3] = 255;
        break;
      case 3: { // palette
        const p = samples[s] * 3;
        out[o] = palette[p]; out[o + 1] = palette[p + 1]; out[o + 2] = palette[p + 2];
        out[o + 3] = img.transparency && samples[s] < img.transparency.length
          ? img.transparency[samples[s]] : 255;
        break;
      }
      case 4: // greyscale + alpha
        out[o] = out[o + 1] = out[o + 2] = to8(samples[s]);
        out[o + 3] = to8(samples[s + 1]);
        break;
      case 6: // rgba
        out[o] = to8(samples[s]);
        out[o + 1] = to8(samples[s + 1]);
        out[o + 2] = to8(samples[s + 2]);
        out[o + 3] = to8(samples[s + 3]);
        break;
      default:
        throw new Error('cannot convert colour type ' + colourType);
    }
  }
  return out;
}

/**
 * Convert a decoded PNG to a Uint16Array of single-channel values.
 *
 * For heightmaps. An 8-bit source is scaled to the full 16-bit range rather
 * than left in 0..255, so downstream code does not have to know which it got.
 */
export function toGrey16(img) {
  const { width, height, colourType, channels, samples, bitDepth } = img;
  if (colourType === 2 || colourType === 6) {
    // Some heightmaps arrive as RGB with the value replicated. Accept that,
    // but only if the channels actually agree - otherwise it is a colour map
    // and treating it as elevation would be silent nonsense.
    for (let i = 0; i < Math.min(width * height, 4096); i++) {
      const s = i * channels;
      if (samples[s] !== samples[s + 1] || samples[s] !== samples[s + 2]) {
        throw new Error('expected greyscale height data, got ' + COLOUR_NAME[colourType] +
          ' with differing channels');
      }
    }
  }
  const n = width * height;
  const out = new Uint16Array(n);
  const scale = bitDepth === 16 ? (v) => v : (v) => (v << 8) | v;
  for (let i = 0; i < n; i++) out[i] = scale(samples[i * channels]);
  return out;
}
