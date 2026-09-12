#!/usr/bin/env node
// Produce a texture set from the manifest.
//
//   node tools/convert/convert.mjs --preflight
//   node tools/convert/convert.mjs --set 4096 --sources v0.0.1 --out build/4096
//   node tools/convert/convert.mjs --set 4096 --from 8192 --kinds Biomes --out build/4096
//
//   --set <name>     the set to produce (4096 / 8192 / 16384)
//   --out <dir>      output directory, laid out like a set directory
//   --sources <tag>  release tag on KSP-RO/RSS-Textures-Source. Defaults to
//                    the latest release; pass a tag to pin an older one
//   --print-tag      resolve the source release and print its tag, nothing else
//   --cache <dir>    where downloaded source zips live, default .cache/sources
//   --from <set>     take pixels from an existing set instead of from sources,
//                    for exercising the pipeline without downloading anything
//   --kinds <list>   only these map kinds, e.g. Biomes,Height
//   --only <list>    only these maps, e.g. EarthBiomes,MimasColor
//   --bodies <list>  only these bodies
//   --jobs <n>       parallel conversions, default 4
//   --report <file>  write a JSON report of everything that happened

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readHeader, fullChainLevels } from '../manifest/lib/dds.mjs';
import { parseSets } from '../manifest/lib/sets.mjs';
import { writeDDS, readLevels } from './lib/dds-io.mjs';
import {
  unpackToRGBA, unpack16, pack16,
  resampleTo, resampleTo16, buildMipChain, packDXT5nm,
} from './lib/pixels.mjs';
import { encodeLevel, backendFor, backendStatus } from './lib/encoders.mjs';
import { compareAgainstShipped } from './lib/heightdiff.mjs';
import { listRelease, fetchAsset, indexZip, extractEntry } from './lib/sources.mjs';
import { normalizeMapName, manifestMapIndex } from '../manifest/lib/mapname.mjs';
import * as png from './lib/png.mjs';

// How each kind is resampled when a set target is smaller than native.
//
// Biome maps must use nearest: their colours are looked up against biome
// definitions, so an averaged colour is a biome that does not exist. Height
// uses median, matching TopoConv, because a box filter flattens peaks.
const RESAMPLE_BY_KIND = {
  Biomes: 'nearest', Height: 'median',
  Color: 'box', Surface: 'box', _NRM: 'box', Ring: 'box',
};

function parseArgs(argv) {
  const o = {
    manifest: 'manifest/textures.json', root: '.', set: null, out: null,
    sources: null, cache: join('.cache', 'sources'), from: null,
    kinds: null, only: null, bodies: null, preflight: false, jobs: 4,
    printTag: false, report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--set') o.set = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--sources') o.sources = argv[++i];
    else if (a === '--cache') o.cache = argv[++i];
    else if (a === '--from') o.from = parseSets(argv[++i])[0];
    else if (a === '--kinds') o.kinds = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--only') o.only = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--bodies') o.bodies = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--preflight') o.preflight = true;
    else if (a === '--print-tag') o.printTag = true;
    else if (a === '--jobs') o.jobs = Number(argv[++i]);
    else if (a === '--report') o.report = argv[++i];
    else throw new Error('unknown option: ' + a);
  }
  return o;
}

/** What the manifest says this map should be, in this set. */
function targetFor(map, setName) {
  const cap = Number(setName);
  const [nw, nh] = map.native;
  const scale = Math.min(1, cap / nw);
  const width = Math.max(1, Math.round(nw * scale));
  const height = Math.max(1, Math.round(nh * scale));
  return {
    width, height, format: map.format,
    levels: map.mips === 'full' ? fullChainLevels(width, height) : 1,
  };
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Load a source image as either 16-bit single channel (heights) or RGBA8.
 *
 * Heights stay 16-bit end to end. Pushing elevation through 8-bit RGBA would
 * quantise terrain to 256 steps, which is a difference you can walk across.
 */
function decodeSource(data, kind, mapName) {
  const img = png.decode(data);
  const notes = [];

  if (kind === 'Height') {
    if (img.bitDepth === 8) {
      notes.push('source is 8-bit; elevation has at most 256 levels');
    }
    // Return scalars, not `img`. Holding the decoded image would pin its
    // `samples` array - 768 MB for a 16384x8192 16-bit source - for the whole
    // conversion, on top of the RGBA copy, the resample and the mip chain.
    // Two of those concurrently is enough to be killed outright.
    return {
      grey16: png.toGrey16(img), width: img.width, height: img.height,
      bitDepth: img.bitDepth, colourType: img.colourType, notes,
    };
  }

  const rgba = png.toRGBA8(img);

  if (kind === 'Biomes') {
    // Biome colours are matched exactly against the definitions in RSS's
    // configs. A 16-bit source whose samples are not exact multiples of 257
    // does not survive truncation to 8 bits: the colour shifts, and a shifted
    // colour is either a different biome or no biome at all.
    if (img.bitDepth === 16) {
      let offGrid = 0;
      const { samples, channels } = img;
      for (let i = 0; i < img.width * img.height; i++) {
        for (let c = 0; c < Math.min(3, channels); c++) {
          const v = samples[i * channels + c];
          if ((v & 0xff) !== (v >> 8)) { offGrid++; break; }
        }
      }
      if (offGrid) {
        notes.push('16-bit source has ' + offGrid + ' texel(s) off the 8-bit grid; ' +
          'truncation shifts those colours and may not match any biome');
      }
    }
    const distinct = new Set();
    for (let i = 0; i < rgba.length; i += 4) {
      distinct.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
      if (distinct.size > 4096) break;
    }
    notes.push(distinct.size + ' distinct colours');
  }

  if (kind === '_NRM') {
    // A greyscale PNG is not a tangent-space normal map, whatever it is named:
    // it is a height or bump map. Swizzling one puts the same value in x and y
    // at every texel, so the whole surface leans the same way and lighting is
    // wrong everywhere. Tethys_Normal.png in source release v0.0.1 is 8-bit
    // greyscale. Better to ship the texture already in the pack.
    if (img.colourType === 0 || img.colourType === 4) {
      return { skip: 'source is ' + img.colour + '; a tangent-space normal map needs RGB' };
    }

    // Confirm the source is a tangent-space normal map before we swizzle it.
    // If someone hands us an already-DXT5nm file, swizzling again destroys it.
    let sumR = 0, sumB = 0, n = 0;
    for (let i = 0; i < rgba.length; i += 4 * 97) { sumR += rgba[i]; sumB += rgba[i + 2]; n++; }
    if (n && sumR / n > 240 && sumB / n > 240) {
      throw new Error(mapName + ': source looks already DXT5nm-swizzled (r,b near white); ' +
        'expected a tangent-space normal map');
    }
  }

  if (kind === 'Color' || kind === 'Surface') {
    // The manifest's format was inferred from the file that shipped. A new
    // source can invalidate that: if the incoming PNG has no alpha at all,
    // DXT5 spends half its bytes storing 255 everywhere.
    let opaque = true;
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] !== 255) { opaque = false; break; }
    }
    if (opaque) notes.push('source alpha is fully opaque' +
      (img.colourType === 2 || img.colourType === 0 ? ' (no alpha channel in the PNG)' : ''));
  }

  // Same reasoning as the height path above: keep the scalars, drop the
  // decoded samples so they can be collected while we still hold the RGBA.
  return {
    rgba, width: img.width, height: img.height,
    bitDepth: img.bitDepth, colourType: img.colourType, notes,
  };
}

/** Read pixels out of an existing DDS in another set (the --from path). */
async function loadFromSet(opts, mapName, install, kind) {
  const path = install === '.'
    ? join(opts.root, opts.from, mapName + '.dds')
    : join(opts.root, opts.from, install, mapName + '.dds');
  if (!(await exists(path))) return { skip: 'absent from set ' + opts.from };

  const h = await readHeader(path);
  if (!h) return { skip: 'unreadable' };
  if (h.format === 'DXT1' || h.format === 'DXT5') {
    return { skip: 'source is ' + h.format + '; decoding and re-encoding would compound loss' };
  }
  const [level0] = await readLevels(path, {
    format: h.format, width: h.width, height: h.height, levels: 1,
  });
  if (h.format === 'R16') {
    return { grey16: unpack16(level0, h.width, h.height), width: h.width, height: h.height, notes: [] };
  }
  if (kind === 'Height') {
    const rgba = unpackToRGBA(level0, h.format, h.width, h.height);
    const g = new Uint16Array(h.width * h.height);
    for (let i = 0; i < g.length; i++) g[i] = (rgba[i * 4] << 8) | rgba[i * 4];
    return { grey16: g, width: h.width, height: h.height, notes: [] };
  }
  return {
    rgba: unpackToRGBA(level0, h.format, h.width, h.height),
    width: h.width, height: h.height, notes: [],
  };
}

/** Convert one map and write it. */
async function convertMap(opts, manifest, ctx, bodyName, kind, map) {
  const mapName = bodyName + kind;
  const install = map.install ?? manifest.kinds[kind].install;
  const target = targetFor(map, opts.set);
  const filter = RESAMPLE_BY_KIND[kind] ?? 'box';

  let src;
  if (opts.from) {
    src = await loadFromSet(opts, mapName, install, kind);
  } else {
    const found = ctx.sourceIndex.get(normalizeMapName(mapName));
    if (!found) return { mapName, skipped: 'no source asset (the source set is partial)' };
    src = decodeSource(extractEntry(found.zip.buf, found.entry), kind, mapName);
  }
  if (src.skip) return { mapName, skipped: src.skip };

  if (src.width < target.width) {
    return {
      mapName,
      skipped: 'source is ' + src.width + 'px, below the ' + target.width + 'px target for this set',
      notes: src.notes,
    };
  }

  // A heightmap with a DEM behind it is generated by heights.mjs, not here.
  //
  // Where a DEM exists, resampling it at each target width is strictly better
  // than shrinking a larger heightmap: measured on the shipped pack, halving
  // the 8192 MoonHeight misses the shipped 4096 by a mean of 183 units (56 m)
  // and a max of 3539 (1075 m), against the map's own neighbour-to-neighbour
  // variation of 366 units. Those are two independent resamplings of the same
  // terrain. heights.mjs runs after this and would overwrite the result
  // anyway, so skipping saves the work rather than losing anything.
  //
  // Most heightmaps have no DEM - the PNG is the primary source, or the map
  // was derived from a normal map in someone's image editor. For those,
  // downscaling the source is the only way to produce a set variant at all,
  // and refusing means the smaller sets ship no terrain for that body.
  if (kind === 'Height' && src.width > target.width && map.topoconv) {
    return {
      mapName,
      skipped: 'has a DEM (' + map.topoconv.dem + '); heights.mjs generates this one at ' +
        target.width + 'px from the DEM',
      notes: src.notes,
    };
  }

  const outPath = install === '.'
    ? join(opts.out, mapName + '.dds')
    : join(opts.out, install, mapName + '.dds');
  await mkdir(dirname(outPath), { recursive: true });

  const result = {
    mapName, format: target.format, size: target.width + 'x' + target.height,
    filter, notes: src.notes ?? [],
  };

  // Surface a format that no longer fits the source.
  if ((kind === 'Color' || kind === 'Surface') && target.format === 'DXT5' &&
      (src.notes ?? []).some((n) => n.startsWith('source alpha is fully opaque'))) {
    result.notes.push('manifest says DXT5 but nothing uses the alpha; DXT1 would halve this file');
  }

  // Height: 16-bit all the way through, written as R16 or R8 per the manifest.
  if (kind === 'Height') {
    let g = { data: src.grey16, width: src.width, height: src.height };
    let downscaled = false;
    if (g.width > target.width) {
      // This is a median-resampled variant of the source heightmap, not the DEM
      // resampled at this width, so it will not match a previously shipped map
      // exactly. How far it moved is measured below.
      result.notes.push('downscaled from ' + src.width + 'px with a ' + filter +
        ' filter; no DEM for this map, so the source heightmap is the only input');
      g = resampleTo16(g.data, g.width, g.height, target.width, filter);
      downscaled = true;
    }
    if (target.format === 'R16') {
      await writeDDS(outPath, target, [pack16(g.data, g.width, g.height)]);
    } else if (target.format === 'R8') {
      const out = Buffer.alloc(g.width * g.height);
      for (let i = 0; i < out.length; i++) out[i] = g.data[i] >> 8;
      await writeDDS(outPath, target, [out]);
      if (src.bitDepth === 16) {
        result.notes.push('16-bit source written as R8 because the manifest says R8');
      }
    } else {
      return { mapName, skipped: 'manifest wants ' + target.format + ' for a heightmap' };
    }
    result.levels = 1;

    // Terrain that moves puts landed craft underground. A downscaled heightmap
    // replaces one this pack already ships, so measure the difference against
    // it and let the build decide whether that is news - the same treatment
    // heights.mjs gives a DEM-derived map.
    if (downscaled) {
      const shipped = install === '.'
        ? join(opts.root, opts.set, mapName + '.dds')
        : join(opts.root, opts.set, install, mapName + '.dds');
      result.comparison = await compareAgainstShipped(outPath, shipped, map.rss);
      const c = result.comparison;
      if (!c.note) {
        result.notes.push('vs the shipped ' + opts.set + ': identical ' +
          c.identicalPct.toFixed(1) + '%, mean ' +
          (c.meanMetres === null ? c.meanUnits.toFixed(1) + ' units' : c.meanMetres.toFixed(1) + ' m') +
          ', max ' +
          (c.maxMetres === null ? c.maxUnits + ' units' : c.maxMetres.toFixed(0) + ' m'));
      }
    }
    return result;
  }

  let rgba = src.rgba;
  let w = src.width, h = src.height;
  if (w > target.width) {
    const scaled = resampleTo(rgba, w, h, target.width, filter);
    rgba = scaled.data; w = scaled.width; h = scaled.height;
  }

  const chain = target.levels > 1
    ? buildMipChain(rgba, w, h, filter)
    : [{ data: rgba, width: w, height: h }];

  // Normal maps are swizzled per level, after mip generation: the mip chain is
  // built from the tangent-space normal, then each level is packed into the
  // DXT5nm layout Unity reads.
  const levelData = [];
  for (const lvl of chain) {
    const pixels = kind === '_NRM' ? packDXT5nm(lvl.data, lvl.width, lvl.height) : lvl.data;
    levelData.push(await encodeLevel(pixels, lvl.width, lvl.height, target.format));
  }
  await writeDDS(outPath, target, levelData);
  result.levels = chain.length;
  return result;
}

/** Run tasks with a bounded number in flight. */
async function pool(items, limit, fn) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

/**
 * Download and index every source zip we might need.
 *
 * Also reports source files the manifest has no entry for. The source set is
 * ahead of the pack in places - it carries heightmaps and normal maps for
 * moons that currently have neither, and bodies (Eris, Hyperion) that are not
 * in the pack at all. Those cannot be built until someone adds them to the
 * manifest, and silently ignoring them would hide new art.
 */
async function loadSources(opts, wantedBodies, manifest) {
  const rel = await listRelease(opts.sources, undefined, { cacheDir: opts.cache });
  const index = new Map();
  const loaded = [];
  const unknownToManifest = [];

  // Keyed on the normalized name, so a source spelled Earth_Color.png is found
  // by a manifest entry called EarthColor and vice versa.
  const declared = manifestMapIndex(manifest);

  for (const [body, entry] of rel.bodies) {
    if (wantedBodies && !wantedBodies.has(body)) continue;
    const { path, cached } = await fetchAsset(entry, opts.cache);
    const zip = await indexZip(path);
    loaded.push({ body, asset: entry.asset, mib: entry.size / 1048576, cached, files: zip.byMap.size });
    for (const [key, e] of zip.byMap) {
      // Report the spelling the file actually used, not the folded key.
      if (!declared.has(key)) unknownToManifest.push({ body: entry.body, map: e.stem });
      if (index.has(key)) continue;
      index.set(key, { zip, entry: e, body });
    }
  }
  return {
    tag: rel.tag, index, loaded, unknownToManifest, shadowed: rel.shadowed ?? [],
    bodiesInRelease: [...rel.bodies.values()].map((b) => b.body),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // No tag is pinned anywhere: a build converts whatever the sources repo
  // published most recently. --sources pins an older release when a build has
  // to be reproduced; --from takes pixels from an existing set and needs no
  // release at all.
  if (!opts.from) opts.sources ??= 'latest';

  if (opts.printTag) {
    console.log((await listRelease(opts.sources, undefined, { cacheDir: opts.cache })).tag);
    return;
  }

  const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));

  if (opts.preflight) {
    console.log('backends');
    for (const b of backendStatus()) {
      console.log('  ' + (b.ok ? 'OK     ' : 'MISSING') + ' ' + b.name.padEnd(16) +
        b.formats.join(',').padEnd(26) + b.detail);
    }
    const need = {};
    for (const body of Object.values(manifest.bodies)) {
      for (const map of Object.values(body.maps)) {
        need[backendFor(map.format) ?? 'unsupported'] = (need[backendFor(map.format) ?? 'unsupported'] ?? 0) + 1;
      }
    }
    console.log('\nmaps by backend');
    for (const [k, v] of Object.entries(need).sort((a, b) => b[1] - a[1])) {
      console.log('  ' + String(v).padStart(4) + '  ' + k);
    }
    if (opts.sources) {
      const rel = await listRelease(opts.sources, undefined, { cacheDir: opts.cache });
      console.log('\nsource release ' + rel.tag + ': ' + rel.bodies.size + ' bodies');
      // rel.bodies is keyed on the lowercased body name; entry.body keeps the
      // spelling the asset used.
      const known = new Set(Object.keys(manifest.bodies).map((b) => b.toLowerCase()));
      const extra = [...rel.bodies.values()]
        .filter((b) => !known.has(b.body.toLowerCase())).map((b) => b.body);
      const missing = Object.keys(manifest.bodies)
        .filter((b) => !rel.bodies.has(b.toLowerCase()));
      console.log('  in the release but not the manifest: ' + (extra.join(', ') || 'none'));
      console.log('  in the manifest but not the release: ' + missing.length + ' bodies' +
        (missing.length ? ' (' + missing.join(', ') + ')' : ''));
      if (rel.shadowed?.length) {
        console.log('  published under both naming schemes, using the unprefixed asset: ' +
          rel.shadowed.map((s) => s.body).join(', '));
      }
    }
    return;
  }

  if (!opts.set) throw new Error('need --set');
  if (!manifest.sets[opts.set]) throw new Error('unknown set: ' + opts.set);
  if (!opts.out) throw new Error('need --out');

  const tasks = [];
  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    if (opts.bodies && !opts.bodies.includes(bodyName)) continue;
    for (const [kind, map] of Object.entries(body.maps)) {
      if (opts.kinds && !opts.kinds.includes(kind)) continue;
      if (opts.only && !opts.only.includes(bodyName + kind)) continue;
      tasks.push({ bodyName, kind, map });
    }
  }

  const ctx = { sourceIndex: new Map() };
  if (opts.sources) {
    const wanted = new Set(tasks.map((t) => t.bodyName.toLowerCase()));
    const s = await loadSources(opts, wanted, manifest);
    ctx.sourceIndex = s.index;
    console.log('source release ' + s.tag + ', ' + s.loaded.length + ' body archive(s)');
    for (const l of s.loaded) {
      console.log('  ' + l.body.padEnd(12) + l.mib.toFixed(1).padStart(8) + ' MiB  ' +
        l.files + ' file(s)  ' + (l.cached ? 'cached' : 'downloaded'));
    }
    if (s.shadowed?.length) {
      console.log('  ' + s.shadowed.length + ' body(ies) published under both naming schemes; ' +
        'used the unprefixed asset:');
      for (const sh of s.shadowed) {
        console.log('    ' + sh.body.padEnd(12) + sh.used + '   (ignored ' + sh.ignored + ')');
      }
    }
    if (s.unknownToManifest.length) {
      console.log('  ' + s.unknownToManifest.length + ' source file(s) with no manifest entry: ' +
        s.unknownToManifest.map((u) => u.map).join(', '));
    }
    console.log('');
  }

  await mkdir(opts.out, { recursive: true });
  const results = await pool(tasks, opts.jobs, (t) =>
    convertMap(opts, manifest, ctx, t.bodyName, t.kind, t.map)
      .catch((err) => ({ mapName: t.bodyName + t.kind, error: err.message })));

  const built = results.filter((r) => r.format && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const failed = results.filter((r) => r.error);

  for (const r of built.sort((a, b) => a.mapName.localeCompare(b.mapName))) {
    console.log('  ' + r.mapName.padEnd(20) + r.size.padEnd(12) + r.format.padEnd(10) +
      r.filter.padEnd(9) + r.levels + ' level(s)');
    for (const n of r.notes ?? []) console.log('      note: ' + n);
  }
  console.log('\nbuilt ' + built.length + ', skipped ' + skipped.length + ', failed ' + failed.length);

  if (skipped.length) {
    const byReason = new Map();
    for (const s of skipped) byReason.set(s.skipped, (byReason.get(s.skipped) ?? 0) + 1);
    console.log('\nskipped:');
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log('  [' + String(n).padStart(3) + '] ' + reason);
    }
  }
  if (opts.report) {
    await writeFile(opts.report, JSON.stringify({ set: opts.set, built, skipped, failed }, null, 2) + '\n');
    console.log('\nwrote ' + opts.report);
  }
  if (failed.length) {
    console.log('\nfailed:');
    for (const f of failed) console.log('  ' + f.mapName + ': ' + f.error);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
