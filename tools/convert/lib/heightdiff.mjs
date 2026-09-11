// How far a generated heightmap has moved the terrain.
//
// Regenerating a heightmap is not a cosmetic change: anything landed on the
// old terrain sits above or below the new one. Both producers of heightmaps
// report this - heights.mjs when it resamples a DEM, convert.mjs when it
// downscales a source PNG - so the answer lives here rather than in one of
// them.
//
// Scale comes from the map's `rss.deformity`: the Kopernicus configs stretch
// the full range of the channel across that many metres, so one unit is
// deformity/max metres and the difference can be stated in metres rather than
// in units nobody can picture.

import { stat } from 'node:fs/promises';
import { readHeader } from '../../manifest/lib/dds.mjs';
import { readLevels } from './dds-io.mjs';

const FULL_SCALE = { R16: 65535, R8: 255 };

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Compare a generated heightmap against the one a set currently ships.
 *
 * Returns `{ note }` when no comparison is possible - a missing counterpart or
 * a different geometry is information, not a failure.
 */
export async function compareAgainstShipped(generated, shipped, rss) {
  if (!(await exists(shipped))) return { note: 'no shipped counterpart at ' + shipped };
  const hg = await readHeader(generated);
  const hs = await readHeader(shipped);
  if (hg.width !== hs.width || hg.height !== hs.height) {
    return { note: 'shipped is ' + hs.width + 'x' + hs.height + ', generated is ' + hg.width + 'x' + hg.height };
  }
  if (hg.format !== hs.format) {
    return { note: 'shipped is ' + hs.format + ', generated is ' + hg.format };
  }
  const scale = FULL_SCALE[hg.format];
  if (!scale) return { note: 'comparison not implemented for ' + hg.format };

  const geom = { format: hg.format, width: hg.width, height: hg.height, levels: 1 };
  const [lg] = await readLevels(generated, geom);
  const [ls] = await readLevels(shipped, geom);

  const bytes = hg.format === 'R16' ? 2 : 1;
  const n = lg.length / bytes;
  const at = (buf, i) => (bytes === 2 ? buf.readUInt16LE(i * 2) : buf[i]);

  const metresPerUnit = (rss?.deformity ?? null) === null ? null : rss.deformity / scale;
  let same = 0, sum = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(at(lg, i) - at(ls, i));
    if (d === 0) same++;
    sum += d;
    if (d > max) max = d;
  }
  const meanUnits = sum / n;
  return {
    identicalPct: same / n * 100,
    meanUnits, maxUnits: max,
    meanMetres: metresPerUnit === null ? null : meanUnits * metresPerUnit,
    maxMetres: metresPerUnit === null ? null : max * metresPerUnit,
  };
}
