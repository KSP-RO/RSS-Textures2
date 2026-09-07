// Decoding BC1/BC3 (DXT1/DXT5) blocks back to RGBA.
//
// Not needed to build anything - the pipeline only ever encodes. This exists
// so encoder output can be checked rather than assumed: decode what we wrote,
// compare against what we fed in, and get a number. It is also the half of an
// encoder A/B comparison that does not depend on which encoder you are testing.

/** Expand an RGB565 endpoint to 8-bit components. */
function rgb565(c) {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  // Replicate the high bits into the low ones, which is what hardware does.
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * Decode a BC1 (DXT1) surface to RGBA8.
 *
 * BC1 has two modes chosen by comparing the endpoints: c0 > c1 gives four
 * opaque colours, c0 <= c1 gives three plus transparent black. Getting that
 * comparison backwards is a classic way to produce subtly wrong output, so it
 * is spelled out rather than assumed.
 */
export function decodeBC1(blocks, width, height) {
  const out = new Uint8Array(width * height * 4);
  const bw = Math.max(1, Math.ceil(width / 4));
  const bh = Math.max(1, Math.ceil(height / 4));
  const palette = new Uint8Array(16);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * 8;
      const c0 = blocks.readUInt16LE(o);
      const c1 = blocks.readUInt16LE(o + 2);
      const bits = blocks.readUInt32LE(o + 4);
      const [r0, g0, b0] = rgb565(c0);
      const [r1, g1, b1] = rgb565(c1);

      palette.set([r0, g0, b0, 255], 0);
      palette.set([r1, g1, b1, 255], 4);
      if (c0 > c1) {
        palette.set([(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0, 255], 8);
        palette.set([(r0 + 2 * r1) / 3 | 0, (g0 + 2 * g1) / 3 | 0, (b0 + 2 * b1) / 3 | 0, 255], 12);
      } else {
        palette.set([(r0 + r1) >> 1, (g0 + g1) >> 1, (b0 + b1) >> 1, 255], 8);
        palette.set([0, 0, 0, 0], 12);
      }

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const idx = (bits >>> (2 * (py * 4 + px))) & 0x3;
          const d = (y * width + x) * 4;
          out[d] = palette[idx * 4];
          out[d + 1] = palette[idx * 4 + 1];
          out[d + 2] = palette[idx * 4 + 2];
          out[d + 3] = palette[idx * 4 + 3];
        }
      }
    }
  }
  return out;
}

/** Decode a BC3 (DXT5) surface to RGBA8. Colour half is BC1's four-colour mode. */
export function decodeBC3(blocks, width, height) {
  const out = new Uint8Array(width * height * 4);
  const bw = Math.max(1, Math.ceil(width / 4));
  const bh = Math.max(1, Math.ceil(height / 4));
  const alpha = new Uint8Array(8);
  const palette = new Uint8Array(16);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * 16;

      const a0 = blocks[o], a1 = blocks[o + 1];
      alpha[0] = a0; alpha[1] = a1;
      if (a0 > a1) {
        for (let i = 1; i < 7; i++) alpha[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
      } else {
        for (let i = 1; i < 5; i++) alpha[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0;
        alpha[6] = 0; alpha[7] = 255;
      }
      // Alpha indices are 3 bits each, 48 bits total, little-endian.
      let alphaBits = 0n;
      for (let i = 7; i >= 2; i--) alphaBits = (alphaBits << 8n) | BigInt(blocks[o + i]);

      const c0 = blocks.readUInt16LE(o + 8);
      const c1 = blocks.readUInt16LE(o + 10);
      const bits = blocks.readUInt32LE(o + 12);
      const [r0, g0, b0] = rgb565(c0);
      const [r1, g1, b1] = rgb565(c1);
      palette.set([r0, g0, b0, 0], 0);
      palette.set([r1, g1, b1, 0], 4);
      palette.set([(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0, 0], 8);
      palette.set([(r0 + 2 * r1) / 3 | 0, (g0 + 2 * g1) / 3 | 0, (b0 + 2 * b1) / 3 | 0, 0], 12);

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const n = py * 4 + px;
          const idx = (bits >>> (2 * n)) & 0x3;
          const aIdx = Number((alphaBits >> BigInt(3 * n)) & 0x7n);
          const d = (y * width + x) * 4;
          out[d] = palette[idx * 4];
          out[d + 1] = palette[idx * 4 + 1];
          out[d + 2] = palette[idx * 4 + 2];
          out[d + 3] = alpha[aIdx];
        }
      }
    }
  }
  return out;
}

export function decodeBlocks(blocks, format, width, height) {
  if (format === 'DXT1') return decodeBC1(blocks, width, height);
  if (format === 'DXT5') return decodeBC3(blocks, width, height);
  throw new Error('decodeBlocks cannot handle ' + format);
}

/**
 * Peak signal-to-noise ratio between two RGBA8 buffers, in dB.
 *
 * `channels` selects which to compare: 3 for RGB, 4 to include alpha. For a
 * normal map in DXT5nm only green and alpha carry data, so comparing all four
 * would average in the meaningless filler.
 */
export function psnr(a, b, channels = 3, pick = null) {
  if (a.length !== b.length) throw new Error('psnr: buffers differ in length');
  let sum = 0, n = 0;
  const chans = pick ?? Array.from({ length: channels }, (_, i) => i);
  for (let i = 0; i < a.length; i += 4) {
    for (const c of chans) {
      const d = a[i + c] - b[i + c];
      sum += d * d;
      n++;
    }
  }
  if (n === 0) return Infinity;
  const mse = sum / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
