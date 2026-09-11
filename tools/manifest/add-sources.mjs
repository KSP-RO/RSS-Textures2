#!/usr/bin/env node
// Add manifest entries for source assets the manifest does not yet declare.
//
//   node tools/manifest/add-sources.mjs --sources v0.0.1
//   node tools/manifest/add-sources.mjs --sources v0.0.1 --write
//   node tools/manifest/add-sources.mjs --sources v0.0.1 --group Eris=Pluto --write
//
//   --sources <tag>   release tag on KSP-RO/RSS-Textures-Source, default latest
//   --cache <dir>     source download cache, default .cache/sources
//   --manifest <file> default manifest/textures.json
//   --group B=G       packaging group for a body the manifest does not know
//   --write           update the manifest (otherwise just report)
//
// Every source release brings maps the pack does not have yet - v0.0.1 adds
// heightmaps and normal maps to moons that currently point at Flat_NRM.dds,
// plus two bodies RSS has no config for at all. Hand-editing JSON for those is
// how a manifest drifts out of step with reality, so this derives each entry
// from the actual PNG.
//
// An entry added here is a map the next release ships. Nothing marks it as
// provisional: everything the sources can produce goes into the package, so a
// map that is declared but absent from the checkout is a gap for the build to
// fill rather than a state to record.

import { readFile, writeFile } from 'node:fs/promises';
import { SETS } from './lib/sets.mjs';
import { readZipDirectory } from './lib/zip.mjs';
import { splitMapName, normalizeMapName, manifestMapIndex } from './lib/mapname.mjs';
import { listRelease, fetchAsset, indexZip, extractEntry } from '../convert/lib/sources.mjs';
import * as png from '../convert/lib/png.mjs';

// Bodies not already in the manifest need a packaging group. Only bodies that
// actually turn up in a source release need an entry here.
const DEFAULT_GROUPS = {
  Hyperion: 'Saturn',  // Saturnian moon
  Eris: 'Pluto',       // no group of its own; Pluto's is the outer-dwarf bucket
};

function parseArgs(argv) {
  const o = {
    sources: 'latest', cache: '.cache/sources',
    manifest: 'manifest/textures.json', write: false, groups: { ...DEFAULT_GROUPS },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sources') o.sources = argv[++i];
    else if (a === '--cache') o.cache = argv[++i];
    else if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--write') o.write = true;
    else if (a === '--group') {
      const [body, group] = argv[++i].split('=');
      if (!body || !group) throw new Error('--group expects Body=Group');
      o.groups[body] = group;
    } else throw new Error('unknown option: ' + a);
  }
  return o;
}

/**
 * Format for a new map.
 *
 * Driven by the kind, not by inspecting the source, with one exception. A
 * normal map is always DXT5 even when the source PNG is fully opaque: the
 * DXT5nm swizzle *creates* the alpha channel to carry x. Choosing DXT1 there
 * because "the source has no alpha" would silently discard half the normal.
 */
function chooseFormat(kind, img, rgba) {
  switch (kind) {
    case '_NRM':
    case 'Ring':
      return 'DXT5';
    case 'Biomes':
      return 'A8B8G8R8';
    case 'Height': {
      if (img.bitDepth !== 16) return 'R8';
      // A 16-bit container does not mean 16 bits of data. Count real levels:
      // an 8-bit map saved as 16-bit would waste half the file for nothing.
      const g = png.toGrey16(img);
      const levels = new Set();
      for (let i = 0; i < g.length && levels.size <= 300; i += 7) levels.add(g[i]);
      return levels.size > 256 ? 'R16' : 'R8';
    }
    case 'Color':
    case 'Surface': {
      let opaque = true;
      for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] !== 255) { opaque = false; break; }
      }
      return opaque ? 'DXT1' : 'DXT5';
    }
    default:
      throw new Error('no format rule for kind ' + kind);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));

  // Keyed on the normalized name, because that is what the source spellings
  // are folded to below: a zip carrying Earth_Color.png must match a manifest
  // entry called EarthColor. Comparing against the canonical spellings instead
  // made every source map look undeclared, which would have rewritten the
  // entire manifest from the sources.
  const declared = manifestMapIndex(manifest);

  // Read each archive's central directory over a range request first, so we
  // only download bodies that actually carry something new.
  const rel = await listRelease(opts.sources);
  const needed = [];
  for (const [body, entry] of rel.bodies) {
    const { entries } = await readZipDirectory(entry.url);
    const stems = entries
      .filter((e) => !e.name.endsWith('/'))
      .map((e) => e.name.split('/').pop().replace(/\.[^.]+$/, ''));
    const fresh = stems.filter((s) => !declared.has(normalizeMapName(s)));
    if (fresh.length) needed.push({ body, entry, fresh });
  }

  if (needed.length === 0) {
    console.log('release ' + rel.tag + ': nothing new, manifest already declares every source map');
    return;
  }
  console.log('release ' + rel.tag + ': ' + needed.reduce((n, b) => n + b.fresh.length, 0) +
    ' undeclared map(s) across ' + needed.length + ' body archive(s)\n');

  const added = [];
  const problems = [];

  for (const { body, entry, fresh } of needed) {
    const { path } = await fetchAsset(entry, opts.cache);
    const index = await indexZip(path);

    for (const stem of fresh.sort()) {
      const { body: mapBody, kind } = splitMapName(stem);
      if (!manifest.kinds[kind]) { problems.push(stem + ': unrecognised map kind'); continue; }

      const zipEntry = index.byMap.get(normalizeMapName(stem));
      const img = png.decode(extractEntry(index.buf, zipEntry));
      const rgba = kind === 'Height' ? null : png.toRGBA8(img);
      const format = chooseFormat(kind, img, rgba);

      const target = manifest.bodies[mapBody] ?? null;
      if (!target) {
        const group = opts.groups[mapBody];
        if (!group) {
          problems.push(mapBody + ': new body with no packaging group (pass --group ' + mapBody + '=<Group>)');
          continue;
        }
        if (!manifest.groups[group]) { problems.push(mapBody + ': unknown group ' + group); continue; }
        manifest.bodies[mapBody] = { group, maps: {} };
        if (!manifest.groups[group].bodies.includes(mapBody)) {
          manifest.groups[group].bodies.push(mapBody);
          manifest.groups[group].bodies.sort();
        }
      }

      const map = {
        native: [img.width, img.height],
        format,
        mips: manifest.kinds[kind].mips,
        source: 'release:' + rel.tag + '/' + entry.asset + '#' + zipEntry.name,
        derivedFrom: null,
        generation: 1,
      };
      if (kind === 'Height') {
        map.rss = { offset: null, deformity: null };
        map.topoconv = null;
      }
      map.todo = kind === 'Height' ? ['rss.offset', 'rss.deformity', 'topoconv'] : [];

      manifest.bodies[mapBody].maps[kind] = map;

      // The map is declared but no DDS for it is in the checkout - it has
      // never shipped. Record that the way every other gap is recorded, so
      // verify.mjs stays green and the list of maps waiting on a release is
      // explicit rather than a rule hidden in the verifier. Each entry clears
      // itself once the map ships, because a deviation that does not fire is
      // never consulted.
      const mapName = mapBody + kind;
      const seen = new Set(manifest.knownDeviations.map((d) => d.map + '|' + d.set + '|' + d.kind));
      for (const set of SETS) {
        if (seen.has(mapName + '|' + set + '|missing')) continue;
        manifest.knownDeviations.push({
          map: mapName, set, kind: 'missing',
          reason: 'declared from a source asset and produced by the build; no DDS for it ' +
            'has ever shipped, so a checkout does not have one. Delete this entry once the map ships.',
        });
      }

      added.push({
        map: stem, body: mapBody, kind, format,
        size: img.width + 'x' + img.height,
        depth: img.bitDepth + '-bit ' + img.colour,
        newBody: !target,
      });
    }
  }

  const pad = (v, n) => String(v).padEnd(n);
  console.log(pad('MAP', 20) + pad('SIZE', 12) + pad('FORMAT', 11) + pad('SOURCE PNG', 24) + 'NOTE');
  for (const a of added.sort((x, y) => x.map.localeCompare(y.map))) {
    console.log(pad(a.map, 20) + pad(a.size, 12) + pad(a.format, 11) + pad(a.depth, 24) +
      (a.newBody ? 'new body -> group ' + manifest.bodies[a.body].group : ''));
  }

  if (problems.length) {
    console.log('\nnot added:');
    for (const p of problems) console.log('  ' + p);
  }

  // Sort bodies and deviations so the file stays diffable.
  manifest.bodies = Object.fromEntries(
    Object.entries(manifest.bodies).sort(([a], [b]) => a.localeCompare(b)));
  manifest.knownDeviations.sort((a, b) =>
    a.map.localeCompare(b.map) ||
    String(a.set).localeCompare(String(b.set)) ||
    a.kind.localeCompare(b.kind));

  if (opts.write) {
    await writeFile(opts.manifest, JSON.stringify(manifest, null, 2) + '\n');
    console.log('\nupdated ' + opts.manifest + ' (' + added.length + ' entries)');
  } else {
    console.log('\n(dry run - pass --write to update the manifest)');
  }
  if (problems.length) process.exit(1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
