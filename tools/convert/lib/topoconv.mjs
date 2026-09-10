// Building a TopoConv command line from a manifest entry.
//
// Separate from heights.mjs so that file can be a pure entry point. A module
// that is both an entry point and an import needs an "am I main?" guard, and
// getting that guard wrong once already turned a script into a silent no-op on
// Linux while it worked on Windows.

/**
 * TopoConv's scale parameters and the Kopernicus config values are the same
 * two numbers wearing different hats:
 *
 *   deformity = 65535 / heightscale     ->  heightscale = 65535 / deformity
 *   offset    = -heightoffs             ->  heightoffs  = -offset
 *
 * TopoConv's -autoscale/-autooffset print exactly these ("Using heightscale:
 * 3.3426 (use deformity=19606)"), which is how the shipped values were
 * obtained in the first place. We pass them explicitly rather than re-deriving
 * them per run, so the mapping from DEM metres to 16-bit units is identical at
 * every output width and cannot drift from what RSS expects. If those three
 * numbers disagree, terrain sits at the wrong altitude.
 */
export function scaleParams(rss) {
  if (rss?.deformity == null || rss?.offset == null) {
    throw new Error('no rss.deformity/rss.offset - run tools/manifest/import-rss.mjs first');
  }
  return {
    heightscale: Number((65535 / rss.deformity).toFixed(6)),
    heightoffs: -rss.offset,
  };
}

/** Full argument list for one heightmap at one output width. */
export function buildCommand(spec, rss, demPath, width, outPath) {
  const { heightscale, heightoffs } = scaleParams(rss);
  const args = [demPath, outPath, '-width', String(width)];

  if (spec.srcEndian === 'big') args.push('-bigendian');
  if (spec.srcFormat === 'fp32') args.push('-fp32');
  // TopoConv infers source dimensions from the file size assuming 2:1, which
  // is exact for 16-bit data (bytes = w * (w/2) * 2 = w^2). srcWidth is only
  // needed when that assumption does not hold.
  if (spec.srcWidth) args.push('-srcwidth', String(spec.srcWidth));

  args.push('-' + (spec.resample ?? 'median'));
  if (spec.inMeridian != null) args.push('-inmeridian', String(spec.inMeridian));
  if (spec.outMeridian != null) args.push('-outmeridian', String(spec.outMeridian));
  for (const f of spec.flip ?? []) args.push('-' + f + 'flip');
  if (spec.coastDefine != null) args.push('-coastdefine', String(spec.coastDefine));

  args.push('-heightscale', String(heightscale));
  args.push('-heightoffs', String(heightoffs));
  args.push('-f', spec.format ?? 'r16');
  return args;
}
