// Block-compression backends.
//
// A backend takes one mip level as RGBA8 and returns the encoded block bytes
// for that level. Mip generation, gamma and the DXT5nm swizzle are all handled
// before we get here, deliberately: encoders generally build mip chains with a
// gamma-naive box filter and clamped edges, which is how you end up with
// planets that darken at distance and a seam down the prime meridian.
//
// Chosen backend is Compressonator: BSD-licensed, prebuilt binaries for
// Windows/Linux/macOS, CPU-only so output does not drift with a GPU driver,
// and it reads and writes plain DDS. The comparison against nvtt / DirectXTex
// / ISPC has not been run - see tools/convert/README.md.

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HEADER_BYTES, levelBytes } from '../../manifest/lib/dds.mjs';
import { writeDDS } from './dds-io.mjs';
import { packFromRGBA } from './pixels.mjs';

/** Formats each backend can produce. */
export const BACKENDS = {
  // Uncompressed formats need no encoder at all: a header plus the raw bytes.
  // That covers 53 of the 110 maps - every biome map and every heightmap.
  raw: {
    formats: ['A8B8G8R8', 'A8R8G8B8', 'R8', 'R16'],
    available: () => ({ ok: true, detail: 'built in' }),
  },
  compressonator: {
    formats: ['DXT1', 'DXT5'],
    available: probeCompressonator,
  },
};

let cachedProbe = null;

function probeCompressonator(exe = process.env.COMPRESSONATOR || 'compressonatorcli') {
  if (cachedProbe) return cachedProbe;
  const r = spawnSync(exe, ['-version'], { encoding: 'utf8' });
  if (r.error) {
    cachedProbe = {
      ok: false,
      detail: 'not found on PATH (set COMPRESSONATOR to its full path). ' +
        'Prebuilt binaries: https://github.com/GPUOpen-Tools/compressonator/releases',
    };
  } else {
    const line = (r.stdout || r.stderr || '').split(/\r?\n/).find((l) => l.trim()) ?? '';
    cachedProbe = { ok: true, detail: line.trim() || exe };
  }
  return cachedProbe;
}

/**
 * Encode one mip level to BC1/BC3 blocks.
 *
 * Compressonator has no "raw blocks out" mode, so we hand it a single-level
 * uncompressed DDS written by our own writer - no PNG encoder needed anywhere
 * in the pipeline - and strip the 128-byte header off what comes back.
 */
export async function encodeLevel(rgba, width, height, format, opts = {}) {
  if (format === 'DXT1' || format === 'DXT5') {
    return encodeWithCompressonator(rgba, width, height, format, opts);
  }
  // Uncompressed: no encoder involved.
  return packFromRGBA(rgba, format, width, height);
}

async function encodeWithCompressonator(rgba, width, height, format, opts) {
  const exe = opts.exe || process.env.COMPRESSONATOR || 'compressonatorcli';
  const probe = probeCompressonator(exe);
  if (!probe.ok) throw new Error('compressonator unavailable: ' + probe.detail);

  const dir = await mkdtemp(join(tmpdir(), 'rss-bc-'));
  try {
    const inPath = join(dir, 'in.dds');
    const outPath = join(dir, 'out.dds');

    // Feed it A8B8G8R8 so channel order is unambiguous either way.
    await writeDDS(inPath, { format: 'A8B8G8R8', width, height, levels: 1 },
      [packFromRGBA(rgba, 'A8B8G8R8', width, height)]);

    const args = [
      '-fd', format === 'DXT1' ? 'BC1' : 'BC3',
      '-miplevels', '1',           // we supply levels ourselves, one at a time
      '-Quality', String(opts.quality ?? 1.0),
      '-NumThreads', String(opts.threads ?? 0),
      inPath, outPath,
    ];
    const r = spawnSync(exe, args, { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error('compressonator exited ' + r.status + ': ' + (r.stderr || r.stdout || '(no output)'));
    }

    const produced = await readFile(outPath);
    const blocks = produced.subarray(HEADER_BYTES);
    const want = levelBytes(format, width, height);
    if (blocks.length !== want) {
      throw new Error(
        'compressonator returned ' + blocks.length + ' block bytes for ' +
        width + 'x' + height + ' ' + format + ', expected ' + want);
    }
    return Buffer.from(blocks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Which backend handles a format, or null. */
export function backendFor(format) {
  for (const [name, b] of Object.entries(BACKENDS)) {
    if (b.formats.includes(format)) return name;
  }
  return null;
}

/** Report backend availability, for a preflight check. */
export function backendStatus() {
  return Object.entries(BACKENDS).map(([name, b]) => ({
    name,
    formats: b.formats,
    ...b.available(),
  }));
}
