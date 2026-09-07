// Pixel handling: unpacking DDS surfaces to RGBA, packing back, resampling,
// and building mip chains.
//
// Everything works on a flat Uint8Array of RGBA8, four bytes per pixel, rows
// top to bottom. R16 is the exception and is handled separately - see
// unpack16/pack16 - because squeezing 16-bit elevation through 8-bit channels
// would quantise terrain.
//
// Two things here are specific to equirectangular planet maps and are the
// reason this is not just a call into a generic image library:
//
//   - Horizontal filtering WRAPS. Longitude 0 and 360 are the same meridian.
//     Clamping there puts a visible seam down every body, at every mip level.
//     This repository has already shipped fixes for exactly that class of bug.
//   - Vertical filtering CLAMPS. The poles are not adjacent to each other.

/** Unpack a DDS surface into RGBA8. Block-compressed formats are not decoded. */
export function unpackToRGBA(buf, format, width, height) {
  const n = width * height;
  const out = new Uint8Array(n * 4);
  switch (format) {
    case 'A8B8G8R8':
      // Stored R,G,B,A in ascending bytes - already our layout.
      out.set(buf.subarray(0, n * 4));
      return out;
    case 'A8R8G8B8':
      for (let i = 0; i < n; i++) {
        out[i * 4] = buf[i * 4 + 2];
        out[i * 4 + 1] = buf[i * 4 + 1];
        out[i * 4 + 2] = buf[i * 4];
        out[i * 4 + 3] = buf[i * 4 + 3];
      }
      return out;
    case 'R8':
      for (let i = 0; i < n; i++) {
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = buf[i];
        out[i * 4 + 3] = 255;
      }
      return out;
    case 'R16':
      // Lossy on purpose: only for inspection. Real 16-bit work uses unpack16.
      for (let i = 0; i < n; i++) {
        const v = buf.readUInt16LE(i * 2) >> 8;
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
        out[i * 4 + 3] = 255;
      }
      return out;
    default:
      throw new Error('unpackToRGBA cannot handle ' + format);
  }
}

/** Pack RGBA8 back into a DDS surface. Inverse of unpackToRGBA. */
export function packFromRGBA(rgba, format, width, height) {
  const n = width * height;
  switch (format) {
    case 'A8B8G8R8': {
      const out = Buffer.alloc(n * 4);
      out.set(rgba.subarray(0, n * 4));
      return out;
    }
    case 'A8R8G8B8': {
      const out = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) {
        out[i * 4] = rgba[i * 4 + 2];
        out[i * 4 + 1] = rgba[i * 4 + 1];
        out[i * 4 + 2] = rgba[i * 4];
        out[i * 4 + 3] = rgba[i * 4 + 3];
      }
      return out;
    }
    case 'R8': {
      const out = Buffer.alloc(n);
      for (let i = 0; i < n; i++) out[i] = rgba[i * 4];
      return out;
    }
    default:
      throw new Error('packFromRGBA cannot handle ' + format);
  }
}

/** Unpack an R16 surface to a Uint16Array, preserving full precision. */
export function unpack16(buf, width, height) {
  const n = width * height;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readUInt16LE(i * 2);
  return out;
}

/** Pack a Uint16Array back into an R16 surface. */
export function pack16(data, width, height) {
  const out = Buffer.alloc(width * height * 2);
  for (let i = 0; i < width * height; i++) out.writeUInt16LE(data[i], i * 2);
  return out;
}

// Address a source texel: longitude wraps, latitude clamps.
//
// Worth being precise about what this does and does not buy. For the 2x2 box
// halving below it is inert: on a power-of-two image a 2x2 footprint never
// straddles x=0, so no tap crosses the seam and clamping would give the same
// answer. It starts mattering for any wider kernel (Lanczos, gaussian) and for
// generating a normal map from height, where the gradient at x=0 must see the
// far edge. Keeping the addressing in one place means those steps get it right
// by default rather than by remembering.
export const wrapX = (x, w) => ((x % w) + w) % w;
export const clampY = (y, h) => (y < 0 ? 0 : y >= h ? h - 1 : y);

/**
 * Halve an RGBA8 image.
 *
 * `filter` is one of:
 *   box      average of the 2x2 source footprint. For continuous data.
 *   nearest  pick one source texel. For indexed data such as biome maps,
 *            where an averaged colour would be a biome that does not exist.
 *   median   per channel median of the footprint. Preserves peaks better than
 *            a box filter on elevation data; this is what TopoConv uses.
 */
export function resampleHalf(rgba, width, height, filter = 'box') {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x * 2, sy = y * 2;
      const o = (y * w + x) * 4;
      if (filter === 'nearest') {
        const si = (clampY(sy, height) * width + wrapX(sx, width)) * 4;
        out[o] = rgba[si]; out[o + 1] = rgba[si + 1];
        out[o + 2] = rgba[si + 2]; out[o + 3] = rgba[si + 3];
        continue;
      }
      const taps = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          taps.push((clampY(sy + dy, height) * width + wrapX(sx + dx, width)) * 4);
        }
      }
      for (let c = 0; c < 4; c++) {
        if (filter === 'median') {
          const vals = taps.map((t) => rgba[t + c]).sort((a, b) => a - b);
          out[o + c] = (vals[1] + vals[2]) >> 1; // mean of the middle two
        } else {
          let sum = 0;
          for (const t of taps) sum += rgba[t + c];
          out[o + c] = (sum + 2) >> 2;
        }
      }
    }
  }
  return { data: out, width: w, height: h };
}

/** Halve a Uint16Array surface, same filters, full 16-bit precision kept. */
export function resampleHalf16(data, width, height, filter = 'box') {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x * 2, sy = y * 2;
      const taps = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          taps.push(data[clampY(sy + dy, height) * width + wrapX(sx + dx, width)]);
        }
      }
      if (filter === 'nearest') out[y * w + x] = taps[0];
      else if (filter === 'median') {
        taps.sort((a, b) => a - b);
        out[y * w + x] = (taps[1] + taps[2]) >> 1;
      } else {
        out[y * w + x] = (taps[0] + taps[1] + taps[2] + taps[3] + 2) >> 2;
      }
    }
  }
  return { data: out, width: w, height: h };
}

/** Repeatedly halve down to `target` width. */
export function resampleTo(rgba, width, height, targetWidth, filter = 'box') {
  let cur = { data: rgba, width, height };
  while (cur.width > targetWidth) {
    cur = resampleHalf(cur.data, cur.width, cur.height, filter);
  }
  return cur;
}

/** Repeatedly halve a 16-bit surface down to `target` width. */
export function resampleTo16(data, width, height, targetWidth, filter = 'box') {
  let cur = { data, width, height };
  while (cur.width > targetWidth) {
    cur = resampleHalf16(cur.data, cur.width, cur.height, filter);
  }
  return cur;
}

/**
 * Build a full mip chain down to 1x1, largest level first.
 *
 * Each level is generated from the level above rather than from the base.
 * That is cheaper and, with a box filter, equivalent.
 */
export function buildMipChain(rgba, width, height, filter = 'box') {
  const chain = [{ data: rgba, width, height }];
  let cur = chain[0];
  while (cur.width > 1 || cur.height > 1) {
    cur = resampleHalf(cur.data, cur.width, cur.height, filter);
    chain.push(cur);
  }
  return chain;
}

/**
 * Pack a normal map into the DXT5nm layout that Unity expects.
 *
 * UnpackNormal reads x from alpha and y from green and ignores red and blue,
 * so those are filler. The shipped pack contains both conventions - white
 * filler on some bodies, y replicated on others - which decode identically.
 * We emit white, and record the choice so it is deliberate rather than an
 * accident of whichever tool ran.
 */
export function packDXT5nm(rgba, width, height) {
  const n = width * height;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = 255;
    out[i * 4 + 1] = rgba[i * 4 + 1];
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = rgba[i * 4];
  }
  return out;
}
