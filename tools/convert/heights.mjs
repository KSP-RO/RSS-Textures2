#!/usr/bin/env node
// Generate heightmaps from raw DEM data with TopoConv.
//
//   node tools/convert/heights.mjs --sources v0.0.1 --set 8192 --out overlay/8192
//   node tools/convert/heights.mjs --dem topo30=D:/Downloads/topo30.raw --set 8192 --out overlay/8192
//   node tools/convert/heights.mjs --list
//
//   --sources <tag>    release tag on KSP-RO/RSS-Textures-Source to fetch DEMs
//                      from ("latest" works), the same tag convert.mjs takes
//   --cache <dir>      where downloaded DEMs live, default .cache/sources
//   --dem <id>=<path>  use a local file for a DEM instead of downloading it.
//                      Repeatable; wins over --sources.
//   --set <name>       which set to generate for
//   --out <dir>        output directory, laid out like a set directory
//   --only <list>      only these maps
//   --compare <set>    after generating, report how far the result is from the
//                      heightmap that set currently ships
//   --drift-warn <m>   mean drift in metres above which the comparison is
//                      called out as a warning. Default 1.
//   --report <file>    write a JSON report of everything that happened
//   --topoconv <path>  TopoConv binary (default: tools/TopoConv/bin/TopoConv
//                      [.exe on Windows], or $TOPOCONV)
//   --list             show which heightmaps have a topoconv spec and a DEM
//   --dry-run          print the commands without running them
//
// Widths come from what a set actually ships, not from min(native, cap): the
// 4096 set carries EarthHeight at 8192x4096, which the manifest records in
// knownDeviations. Generating at the rule's width instead would quietly halve
// the resolution of a texture that already ships.
//
// Drift is reported, not enforced. Regenerating a heightmap moves terrain, and
// terrain that moves puts landed craft underground - but changing the source
// DEM is a legitimate, deliberate act, sometimes paired with a coordinated
// RealSolarSystem config release. A build that refused to package moved terrain
// would leave no way to ship that change at all. So the comparison is loud, it
// lands in the report and the job summary, and the release still gets cut.
//
// Why this is separate from convert.mjs: heightmaps are not resampled from a
// larger heightmap, they are resampled from the source DEM at each target
// width. Measured on the shipped pack, halving an 8192 heightmap misses the
// shipped 4096 by a mean of 56 m and a maximum of over 1 km - the two are
// independent resamplings of the same terrain, not one derived from the other.
//
// The scale and offset are NOT parameters here. They are derived from the
// manifest's rss.deformity and rss.offset, which are copied from the Kopernicus
// configs in RSS. That is deliberate: those three numbers have to agree or
// terrain sits at the wrong altitude, and deriving them removes the chance of
// them drifting apart.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { readHeader } from '../manifest/lib/dds.mjs';
import { readLevels } from './lib/dds-io.mjs';
import { unpack16 } from './lib/pixels.mjs';
import { buildCommand } from './lib/topoconv.mjs';
import { listRelease, fetchAsset } from './lib/sources.mjs';

// The Windows binary is committed; the Linux one is built by
// `make -C tools/TopoConv`. Both are bin/TopoConv, only the suffix differs,
// and both were verified to produce byte-identical heightmaps.
const DEFAULT_TOPOCONV = join('tools', 'TopoConv', 'bin',
  process.platform === 'win32' ? 'TopoConv.exe' : 'TopoConv');

function parseArgs(argv) {
  const o = {
    manifest: 'manifest/textures.json', set: null, out: null, only: null,
    dems: {}, topoconv: process.env.TOPOCONV || DEFAULT_TOPOCONV,
    sources: null, cache: join('.cache', 'sources'),
    compare: null, driftWarn: 1, report: null, list: false, dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--set') o.set = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--only') o.only = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--topoconv') o.topoconv = argv[++i];
    else if (a === '--sources') o.sources = argv[++i];
    else if (a === '--cache') o.cache = argv[++i];
    else if (a === '--compare') o.compare = argv[++i];
    else if (a === '--drift-warn') o.driftWarn = Number(argv[++i]);
    else if (a === '--report') o.report = argv[++i];
    else if (a === '--list') o.list = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--dem') {
      const v = argv[++i];
      const eq = v.indexOf('=');
      if (eq < 0) throw new Error('--dem expects <id>=<path>');
      o.dems[v.slice(0, eq)] = v.slice(eq + 1);
    } else throw new Error('unknown option: ' + a);
  }
  return o;
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * The width a set actually ships for a map.
 *
 * The manifest's rule is min(native, setCap), but knownDeviations records
 * where the pack disagrees with it, and for heightmaps it does: the 4096 set
 * ships EarthHeight at 8192x4096. Generating at 4096 would replace a texture
 * that already ships with one of half the resolution, and nothing downstream
 * would object - build.mjs packages whatever the overlay contains without
 * re-checking its geometry.
 */
function shippedWidth(manifest, mapName, setName, map) {
  const width = Math.min(map.native[0], Number(setName));
  const dev = (manifest.knownDeviations ?? []).find(
    (d) => d.map === mapName && d.set === setName && d.kind === 'size' && d.actual);
  return dev ? dev.actual : width;
}

/**
 * Locate every DEM a run needs: a local --dem path, or an asset on the source
 * release fetched into the cache.
 *
 * DEMs are published raw rather than zipped. topo30.raw is 1.74 GiB, inside
 * GitHub's 2 GiB per-asset limit, and a zip that size cannot be inflated in
 * memory - so a zipped asset is refused with an explanation rather than
 * half-supported.
 */
async function locateDems(manifest, opts, needed) {
  const located = {};
  const problems = [];
  let release = null;

  for (const id of needed) {
    if (opts.dems[id]) { located[id] = opts.dems[id]; continue; }

    const dem = manifest.dems?.[id];

    // A dry run prints commands, so it must not need the DEM to exist - which
    // is what lets CI smoke-test this step in the cheap gate job, before any
    // build job has spent a 1.74 GiB download.
    if (opts.dryRun) { located[id] = '<' + (dem?.asset ?? id) + '>'; continue; }

    if (!opts.sources) continue;

    if (!dem?.asset) {
      problems.push('DEM "' + id + '" has no "asset" field in the manifest, so it ' +
        'cannot be fetched from a release. Pass --dem ' + id + '=<path>.');
      continue;
    }
    if (/\.zip$/i.test(dem.asset)) {
      problems.push('DEM "' + id + '" is declared as a zip (' + dem.asset + '). ' +
        'DEMs must be published raw; a 1.74 GiB zip cannot be inflated in memory.');
      continue;
    }

    release ??= await listRelease(opts.sources);
    const entry = release.assets.get(dem.asset);
    if (!entry) {
      problems.push('release ' + release.tag + ' has no asset "' + dem.asset +
        '" for DEM "' + id + '". Assets: ' + [...release.assets.keys()].join(', '));
      continue;
    }
    // Check the size the release advertises before spending the download on
    // it. fetchAsset verifies the bytes that actually arrive against this.
    if (dem.bytes && entry.size !== dem.bytes) {
      problems.push('release asset ' + dem.asset + ' is ' + entry.size +
        ' bytes, manifest expects ' + dem.bytes + ' - wrong file, or a different revision');
      continue;
    }

    const { path, cached } = await fetchAsset(entry, opts.cache);
    console.log('  DEM ' + id.padEnd(12) + dem.asset + '  ' +
      (entry.size / 1024 / 1024 / 1024).toFixed(2) + ' GiB  ' +
      (cached ? 'cached' : 'downloaded'));
    located[id] = path;
  }

  if (problems.length) throw new Error(problems.join('\n'));
  return located;
}

/** Compare a generated heightmap against the one a set currently ships. */
async function compareAgainstShipped(generated, shipped, rss) {
  if (!(await exists(shipped))) return { note: 'no shipped counterpart at ' + shipped };
  const hg = await readHeader(generated);
  const hs = await readHeader(shipped);
  if (hg.width !== hs.width || hg.height !== hs.height) {
    return { note: 'shipped is ' + hs.width + 'x' + hs.height + ', generated is ' + hg.width + 'x' + hg.height };
  }
  if (hg.format !== 'R16' || hs.format !== 'R16') {
    return { note: 'comparison only implemented for R16 (' + hs.format + ' vs ' + hg.format + ')' };
  }
  const [lg] = await readLevels(generated, { format: 'R16', width: hg.width, height: hg.height, levels: 1 });
  const [ls] = await readLevels(shipped, { format: 'R16', width: hs.width, height: hs.height, levels: 1 });
  const G = unpack16(lg, hg.width, hg.height);
  const S = unpack16(ls, hs.width, hs.height);

  const metresPerUnit = rss.deformity / 65535;
  let same = 0, sum = 0, max = 0;
  for (let i = 0; i < G.length; i++) {
    const d = Math.abs(G[i] - S[i]);
    if (d === 0) same++;
    sum += d;
    if (d > max) max = d;
  }
  return {
    identicalPct: same / G.length * 100,
    meanMetres: (sum / G.length) * metresPerUnit,
    maxMetres: max * metresPerUnit,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));
  const dems = manifest.dems ?? {};

  // Every heightmap that declares how to regenerate itself.
  const specs = [];
  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    const map = body.maps.Height;
    if (!map?.topoconv) continue;
    const mapName = bodyName + 'Height';
    if (opts.only && !opts.only.includes(mapName)) continue;
    specs.push({ mapName, bodyName, map, spec: map.topoconv });
  }

  if (opts.list) {
    console.log('heightmaps with a topoconv spec: ' + specs.length + ' of ' +
      Object.values(manifest.bodies).filter((b) => b.maps.Height).length + ' heightmaps\n');
    for (const s of specs) {
      const demId = s.spec.dem;
      const dem = dems[demId];
      const path = opts.dems[demId];
      const how = path ? 'local file'
        : dem?.asset ? 'release asset ' + dem.asset
        : 'no source: needs --dem ' + demId + '=<path>';
      console.log('  ' + s.mapName.padEnd(16) + 'dem=' + String(demId).padEnd(12) +
        (dem ? dem.width + 'x' + dem.height + ' ' + dem.format : 'NOT DECLARED') +
        '   ' + how);
    }
    const without = Object.entries(manifest.bodies)
      .filter(([, b]) => b.maps.Height && !b.maps.Height.topoconv)
      .map(([n]) => n + 'Height');
    if (without.length) {
      console.log('\nno topoconv spec (' + without.length + '): ' + without.join(', '));
    }
    return;
  }

  if (!opts.set) throw new Error('need --set');
  if (!manifest.sets[opts.set]) throw new Error('unknown set: ' + opts.set);
  if (!opts.out) throw new Error('need --out');

  const haveTopoConv = await exists(opts.topoconv);
  if (!haveTopoConv && !opts.dryRun) {
    throw new Error('TopoConv not found at ' + opts.topoconv + '\n' +
      (process.platform === 'win32'
        ? 'The Windows binary is committed at ' + DEFAULT_TOPOCONV + '.'
        : 'Build it with: make -C tools/TopoConv') +
      '\nOr set --topoconv / $TOPOCONV to point at your own.');
  }

  // Fetch or locate every DEM the run needs before touching TopoConv, so a
  // bad asset name fails in seconds rather than after a gigabyte of download.
  const needed = [...new Set(specs.map((s) => s.spec.dem))];
  const demPaths = await locateDems(manifest, opts, needed);

  const built = [], skipped = [];
  for (const s of specs) {
    const demPath = demPaths[s.spec.dem];
    if (!demPath) {
      skipped.push({ map: s.mapName, why: 'DEM "' + s.spec.dem + '" not supplied' +
        (opts.sources ? '' : ' (pass --sources <tag> or --dem ' + s.spec.dem + '=<path>)') });
      continue;
    }
    if (!opts.dryRun && !(await exists(demPath))) {
      skipped.push({ map: s.mapName, why: 'DEM file missing: ' + demPath });
      continue;
    }

    const width = shippedWidth(manifest, s.mapName, opts.set, s.map);
    const install = s.map.install ?? manifest.kinds.Height.install;
    const outPath = install === '.'
      ? join(opts.out, s.mapName + '.dds')
      : join(opts.out, install, s.mapName + '.dds');
    await mkdir(dirname(outPath), { recursive: true });

    const args = buildCommand(s.spec, s.map.rss, demPath, width, outPath);
    if (opts.dryRun) {
      console.log('  ' + opts.topoconv + ' ' + args.join(' '));
      continue;
    }

    const t0 = Date.now();
    const r = spawnSync(opts.topoconv, args, { encoding: 'utf8' });
    if (r.error) throw new Error('could not run TopoConv: ' + r.error.message);
    if (r.status !== 0) {
      throw new Error(s.mapName + ': TopoConv exited ' + r.status + '\n' + (r.stderr || r.stdout));
    }
    const secs = (Date.now() - t0) / 1000;

    // TopoConv prints the achieved range; keep it, it is the cheapest sanity
    // check that the DEM was read with the right endianness.
    const range = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('Height Range:'));
    const header = await readHeader(outPath);

    // Check the one thing TopoConv could silently get wrong: geometry. A
    // tree-wide verify is no use here because a heights run only produces
    // heightmaps, so every other map in the set would read as missing.
    const wantHeight = Math.max(1, Math.round(s.map.native[1] * (width / s.map.native[0])));
    const problems = [];
    if (header.width !== width || header.height !== wantHeight) {
      problems.push('geometry is ' + header.width + 'x' + header.height +
        ', manifest wants ' + width + 'x' + wantHeight);
    }
    if (header.format !== s.map.format) {
      problems.push('format is ' + header.format + ', manifest wants ' + s.map.format);
    }
    if (header.expectedBytes !== null && header.expectedBytes !== header.bytes) {
      problems.push('file is ' + header.bytes + ' bytes, geometry implies ' + header.expectedBytes);
    }
    if (problems.length) {
      throw new Error(s.mapName + ': ' + problems.join('; '));
    }

    const entry = {
      map: s.mapName, size: header.width + 'x' + header.height, format: header.format,
      seconds: secs, range: range ? range.replace('Height Range: ', '').trim() : null,
    };

    if (opts.compare) {
      const shipped = install === '.'
        ? join(opts.compare, s.mapName + '.dds')
        : join(opts.compare, install, s.mapName + '.dds');
      entry.comparison = await compareAgainstShipped(outPath, shipped, s.map.rss);
    }
    built.push(entry);
  }

  const drifted = [];
  for (const b of built) {
    console.log('  ' + b.map.padEnd(16) + b.size.padEnd(12) + b.format.padEnd(6) +
      b.seconds.toFixed(1).padStart(6) + ' s   range ' + (b.range ?? '?'));
    const c = b.comparison;
    if (!c) continue;
    if (c.note) { console.log('      vs shipped: ' + c.note); continue; }
    console.log('      vs shipped: identical ' + c.identicalPct.toFixed(2) + '%   ' +
      'mean ' + c.meanMetres.toFixed(1) + ' m   max ' + c.maxMetres.toFixed(0) + ' m');

    if (c.meanMetres > opts.driftWarn) {
      b.drifted = true;
      drifted.push({ map: b.map, mean: c.meanMetres, max: c.maxMetres });
      console.log('      TERRAIN MOVED: more than ' + opts.driftWarn +
        ' m from the shipped heightmap on average.');
      console.log('      Anything landed on the old terrain will be above or below it.');
    }
  }
  console.log('\ngenerated ' + built.length + ', skipped ' + skipped.length);
  for (const s of skipped) console.log('  ' + s.map.padEnd(16) + s.why);

  // Loud, but not fatal. Changing the source DEM is a deliberate act, and
  // sometimes goes out with a coordinated RealSolarSystem config release, so
  // refusing to package moved terrain would leave no way to ship it. The
  // caller decides what to do with this; the release still gets cut.
  if (drifted.length) {
    console.log('\n' + drifted.length + ' heightmap(s) moved terrain:');
    for (const d of drifted) {
      console.log('  ' + d.map.padEnd(16) + 'mean ' + d.mean.toFixed(1) +
        ' m, max ' + d.max.toFixed(0) + ' m');
    }
    console.log('This is expected when the DEM has changed on purpose. Say so in the\n' +
      'release notes, and check whether the offset/deformity values in RSS still\n' +
      'match - they are what map these 16-bit units back to metres.');
  }

  if (opts.report) {
    await writeFile(opts.report, JSON.stringify({
      set: opts.set, driftWarn: opts.driftWarn, built, skipped, drifted,
    }, null, 2) + '\n');
    console.log('\nwrote ' + opts.report);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
