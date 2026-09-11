#!/usr/bin/env node
// Generate a starting manifest from what is currently on disk.
//
//   node tools/manifest/bootstrap.mjs --observed <scan.json> --out manifest/textures.json
//
// This is a one-time bootstrap, not part of the build. It turns observations
// into a first draft of intent, then records every place the shipped files
// disagree with that intent under "knownDeviations" so verify.mjs starts green
// and the backlog is explicit rather than invisible.
//
// Re-running it against a drifted tree would launder bugs back into intent.
// Edit manifest/textures.json by hand from here on.

import { readFile, writeFile } from 'node:fs/promises';
import { splitMapName } from './lib/mapname.mjs';
import { SETS } from './lib/sets.mjs';

// Textures that belong to no body.
//
// Flat_NRM is a placeholder normal map that ten RSS configs point at where a
// body has no real one. Deriving bodies from filenames alone invented a body
// called "Flat" and a packaging group to hold it, which then needed a
// hardcoded exclusion everywhere bodies were counted - and put the texture in
// exactly one group asset instead of all of them, so which groups you
// installed decided whether you got it.
const SHARED = new Set(['Flat_NRM']);

// Release packaging groups. Sizes in the header comment are compressed bytes
// from the v18.6.1 16384.zip, as a sanity check that no group approaches
// GitHub's 2 GiB per-asset limit.
const GROUPS = {
  Mercury: { bodies: ['Mercury'] },
  Venus:   { bodies: ['Venus'] },
  Earth:   { bodies: ['Earth', 'Moon'] },
  Mars:    { bodies: ['Mars', 'Phobos', 'Deimos'] },
  Belt:    { bodies: ['Vesta', 'Ceres'] },
  Jupiter: { bodies: ['Jupiter', 'Io', 'Europa', 'Ganymede', 'Callisto'] },
  Saturn:  { bodies: ['Saturn', 'Mimas', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Titan', 'Iapetus'] },
  Uranus:  { bodies: ['Uranus', 'Miranda', 'Ariel', 'Umbriel', 'Titania', 'Oberon'] },
  Neptune: { bodies: ['Neptune', 'Triton'] },
  Pluto:   { bodies: ['Pluto', 'Charon'] },
};

const KINDS = {
  Color: {
    install: 'PluginData', mips: 'full', colorspace: 'srgb',
    formats: ['DXT1', 'DXT5'],
    note: 'DXT1 unless the alpha channel carries real data. Mips built in linear space.',
  },
  Surface: {
    install: 'PluginData', mips: 'full', colorspace: 'srgb',
    formats: ['DXT1', 'DXT5'],
    note: 'Detail/surface texture sampled close up.',
  },
  _NRM: {
    install: 'PluginData', mips: 'full', colorspace: 'linear',
    formats: ['DXT5'],
    note: 'DXT5nm: x in alpha, y in green. Unity UnpackNormal ignores red and blue.',
  },
  Height: {
    install: 'PluginData', mips: 'none', colorspace: 'linear',
    formats: ['R16', 'R8'],
    note: 'Never block-compressed. Changing scale or offset moves terrain under landed craft and must be coordinated with RSS.',
  },
  Biomes: {
    install: 'PluginData', mips: 'none', colorspace: 'srgb',
    formats: ['A8B8G8R8'],
    note: 'Exact RGB lookup against biome definitions. Never compressed, never mipped, point filtered.',
  },
  Ring: {
    install: 'PluginData', mips: 'full', colorspace: 'srgb',
    formats: ['DXT5'],
    note: 'Alpha is meaningful (ring gaps).',
  },
};

function groupOf(body) {
  for (const [name, g] of Object.entries(GROUPS)) if (g.bodies.includes(body)) return name;
  return null;
}

/** Intended format for a map, given what we observed across the sets. */
function intendedFormat(kind, cells) {
  const seen = cells.map((c) => c.format);
  if (kind === 'Biomes') return 'A8B8G8R8';
  if (kind === '_NRM' || kind === 'Ring') return 'DXT5';
  if (kind === 'Height') return seen.includes('R16') ? 'R16' : 'R8';
  // Colour and surface maps: DXT5 only earns its extra 4 bits per pixel when
  // some set actually has non-opaque alpha. alphaOpaque comes from --alpha.
  const anyAlphaUsed = cells.some((c) => c.format === 'DXT5' && c.alphaOpaque === false);
  return anyAlphaUsed ? 'DXT5' : 'DXT1';
}

function intendedMips(kind) {
  return KINDS[kind].mips;
}

async function main() {
  const args = process.argv.slice(2);
  let observedPath = null, outPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--observed') observedPath = args[++i];
    else if (args[i] === '--out') outPath = args[++i];
    else throw new Error('unknown option: ' + args[i]);
  }
  if (!observedPath || !outPath) throw new Error('need --observed and --out');

  const observed = JSON.parse(await readFile(observedPath, 'utf8'));
  const bodies = {};
  const shared = {};
  const knownDeviations = [];

  for (const [mapName, m] of Object.entries(observed.maps)) {
    const { body, kind } = splitMapName(mapName);

    // Shared textures are identical in every set and owned by no body, so they
    // get a flat entry rather than being forced into the body/kind shape.
    if (SHARED.has(mapName)) {
      const cell = SETS.map((s) => m.sets[s]).find(Boolean);
      if (cell) {
        shared[mapName] = {
          native: [cell.width, cell.height],
          format: cell.format,
          mips: cell.mips,
          install: cell.install === '.' ? '.' : 'PluginData',
          source: null,
          note: 'Belongs to no body; packaged into every asset. See tools/manifest/README.md.',
        };
      }
      continue;
    }

    if (!KINDS[kind]) {
      knownDeviations.push({ map: mapName, kind: 'unclassified', reason: 'filename does not end in a known map kind' });
      continue;
    }
    const cells = SETS.map((s) => m.sets[s]).filter(Boolean);
    if (cells.length === 0) continue;

    const native = Math.max(...cells.map((c) => c.width));
    const nativeH = Math.max(...cells.map((c) => c.height));
    const format = intendedFormat(kind, cells);
    const mips = intendedMips(kind);
    const install = cells[0].install;

    const entry = {
      native: [native, nativeH],
      format,
      mips,
      // Provenance. Filled in as assets are re-sourced; see tools/manifest/README.md.
      source: null,
      derivedFrom: null,
      generation: 1,
    };
    if (install !== KINDS[kind].install) entry.install = install;
    if (kind === 'Height') {
      entry.rss = { offset: null, deformity: null };
      // TopoConv owns longitude wrap and polar discontinuities for heightmaps
      // (-fixpoles, -inmeridian/-outmeridian, the resampler choice). The exact
      // invocation determines the terrain, and therefore the rss values above,
      // so it belongs next to them rather than in someone's shell history.
      entry.topoconv = null;
    }

    const todo = ['source'];
    if (kind === 'Height') todo.push('rss.offset', 'rss.deformity', 'topoconv');
    entry.todo = todo;

    (bodies[body] ??= { group: groupOf(body), maps: {} }).maps[kind] = entry;

    // Record how the shipped files differ from the intent above.
    for (const set of SETS) {
      const c = m.sets[set];
      const target = Math.min(native, Number(set));
      if (!c) {
        knownDeviations.push({
          map: mapName, set, kind: 'missing',
          reason: 'absent from the checkout; only the 16384 release asset is consulted ' +
            'for recovery, so a file shipped solely in a smaller pack looks missing here',
        });
        continue;
      }
      // Recovered from the release rather than read off disk: the shipped file
      // is over GitHub's 100 MiB limit, so a plain checkout will not have it.
      // Note this even when the *intended* format would fit, because the
      // file that is actually missing today is the one that shipped.
      if (typeof c.source === 'string' && c.source.startsWith('release:')) {
        knownDeviations.push({
          map: mapName, set, kind: 'missing',
          reason: 'shipped file (' + c.format + ', ' + c.mips + ' mips, ' +
            (c.bytes / 1048576).toFixed(1) + ' MiB) exceeds the GitHub 100 MiB limit; ' +
            'present only in the release zip',
        });
      }
      if (c.width !== target) {
        knownDeviations.push({
          map: mapName, set, kind: 'size',
          expected: target, actual: c.width,
          reason: 'set ships a resolution that is not min(native, setCap)',
        });
      }
      if (c.format !== format) {
        knownDeviations.push({
          map: mapName, set, kind: 'format',
          expected: format, actual: c.format,
          reason: c.format === 'DXT5' && c.alphaOpaque
            ? 'DXT5 with a fully opaque alpha channel; DXT1 is half the size'
            : 'format differs from the intent for this map kind',
        });
      }
      if (c.mips !== mips) {
        knownDeviations.push({
          map: mapName, set, kind: 'mips',
          expected: mips, actual: c.mips,
          reason: mips === 'full' ? 'missing mip chain causes shimmering at distance' : 'mips present where none are wanted',
        });
      }
    }
  }

  const manifest = {
    manifestVersion: 1,
    generatedFrom: { scan: observed.generatedAt, release: observed.release?.tag ?? null },
    readme: 'tools/manifest/README.md',
    sets: Object.fromEntries(SETS.map((s) => [s, { cap: Number(s), package: true }])),
    groups: GROUPS,
    shared,
    kinds: KINDS,
    bodies: Object.fromEntries(Object.entries(bodies).sort(([a], [b]) => a.localeCompare(b))),
    knownDeviations: knownDeviations.sort(
      (a, b) => a.map.localeCompare(b.map) || String(a.set).localeCompare(String(b.set)),
    ),
  };

  await writeFile(outPath, JSON.stringify(manifest, null, 2) + '\n');

  const byKind = {};
  for (const d of knownDeviations) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  console.log('wrote ' + outPath);
  console.log('  bodies: ' + Object.keys(manifest.bodies).length);
  console.log('  shared: ' + Object.keys(shared).join(', '));
  console.log('  maps:   ' + Object.values(bodies).reduce((n, b) => n + Object.keys(b.maps).length, 0));
  console.log('  known deviations: ' + knownDeviations.length +
    ' (' + Object.entries(byKind).map(([k, v]) => k + ' ' + v).join(', ') + ')');
  const ungrouped = Object.entries(manifest.bodies).filter(([, b]) => !b.group).map(([n]) => n);
  if (ungrouped.length) console.log('  WARNING ungrouped bodies: ' + ungrouped.join(', '));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
