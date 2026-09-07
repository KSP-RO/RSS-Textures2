#!/usr/bin/env node
// Check biome maps against the biome definitions in RSS.
//
//   node tools/manifest/check-biomes.mjs --rss ../KSP-RSS --root . --set 4096
//   node tools/manifest/check-biomes.mjs --rss ../KSP-RSS --tree build/4096
//
//   --rss <dir>    checkout of KSP-RO/RealSolarSystem
//   --root <dir>   repo root, used with --set
//   --set <name>   which set's biome maps to check
//   --tree <dir>   check a directory laid out like a set instead
//   --max <n>      list at most this many stray colours per body (default 8)
//
// A biome map is not a picture. Kopernicus looks each texel's colour up
// against the Biome list in the body's config, so a colour that is not in that
// list is not a biome - it is a hole where science and terrain queries land on
// nothing. Anti-aliased edges, lossy compression and 16-bit truncation all
// produce exactly that, silently.
//
// This reads the colours RSS actually declares and reports what fraction of
// each map does not match one.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readHeader } from './lib/dds.mjs';
import { readLevels } from '../convert/lib/dds-io.mjs';
import { unpackToRGBA } from '../convert/lib/pixels.mjs';

function parseArgs(argv) {
  const o = { rss: null, root: '.', set: null, tree: null, max: 8 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rss') o.rss = argv[++i];
    else if (argv[i] === '--root') o.root = argv[++i];
    else if (argv[i] === '--set') o.set = argv[++i];
    else if (argv[i] === '--tree') o.tree = argv[++i];
    else if (argv[i] === '--max') o.max = Number(argv[++i]);
    else throw new Error('unknown option: ' + argv[i]);
  }
  if (!o.rss) throw new Error('need --rss <path to RealSolarSystem checkout>');
  if (!o.set && !o.tree) throw new Error('need --set <name> or --tree <dir>');
  return o;
}

async function* walkCfg(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkCfg(full);
    else if (e.name.toLowerCase().endsWith('.cfg')) yield full;
  }
}

/** "1,1,1,1" or "0.5, 0.25, 0, 1" -> packed 0xRRGGBB */
function parseColour(text) {
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  // Kopernicus colours are floats in 0..1. Values above 1 would be a config
  // already written in bytes; accept both rather than silently mangling one.
  const scale = parts.slice(0, 3).some((n) => n > 1.0001) ? 1 : 255;
  const [r, g, b] = parts.slice(0, 3).map((n) => Math.round(n * scale));
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/**
 * Collect declared biome colours per body.
 *
 * Rather than parse the whole node tree, track the most recent `name = X` seen
 * at the point a Biome node's colour appears, and attribute it to the config
 * file's stem. In the RSS layout each body has its own file, so the stem is
 * the body; the in-node name is kept only to flag a disagreement.
 */
async function collectBiomes(rssDir) {
  const byBody = new Map();
  let files = 0;
  for await (const cfg of walkCfg(join(rssDir, 'GameData'))) {
    const text = await readFile(cfg, 'utf8');
    if (!/\bBiome\b/.test(text)) continue;
    files++;
    const body = cfg.split(/[\\/]/).pop().replace(/\.cfg$/i, '');

    const lines = text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ''));
    let pendingName = null;
    for (const line of lines) {
      const nm = line.match(/^\s*(?:[@%!+\-*]*)name\s*=\s*(.+?)\s*$/i);
      if (nm) { pendingName = nm[1]; continue; }
      const cm = line.match(/^\s*(?:[@%!+\-*]*)color\s*=\s*(.+?)\s*$/i);
      if (!cm) continue;
      const packed = parseColour(cm[1]);
      if (packed === null) continue;
      if (!byBody.has(body)) byBody.set(body, new Map());
      if (!byBody.get(body).has(packed)) byBody.get(body).set(packed, pendingName ?? '(unnamed)');
    }
  }
  return { byBody, files };
}

const hex = (v) => '#' + v.toString(16).padStart(6, '0');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { byBody, files } = await collectBiomes(opts.rss);
  console.log('read ' + files + ' config(s) declaring biomes for ' + byBody.size + ' bodies\n');

  const dir = opts.tree ?? join(opts.root, opts.set);
  const pluginData = join(dir, 'PluginData');
  let names;
  try {
    names = (await readdir(pluginData)).filter((n) => /Biomes\.dds$/i.test(n));
  } catch {
    throw new Error('no PluginData directory under ' + dir);
  }
  if (names.length === 0) throw new Error('no biome maps found in ' + pluginData);

  let clean = 0, dirty = 0, unknownBody = 0;
  const rows = [];

  for (const name of names.sort()) {
    const body = name.replace(/Biomes\.dds$/i, '');
    const declared = byBody.get(body);
    const path = join(pluginData, name);
    const h = await readHeader(path);
    if (!h) continue;
    if (!declared) { unknownBody++; rows.push({ body, note: 'no biome definitions found in RSS' }); continue; }

    const [l0] = await readLevels(path, { format: h.format, width: h.width, height: h.height, levels: 1 });
    const rgba = unpackToRGBA(l0, h.format, h.width, h.height);

    const counts = new Map();
    for (let i = 0; i < rgba.length; i += 4) {
      const k = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const total = rgba.length / 4;

    // Exactness alone over-reports. Several maps sit a channel or two away
    // from a declared colour (Neptune's map has #ff00e1 against a declared
    // #ff00ff), which is harmless if Kopernicus resolves a texel to its
    // nearest declared biome and fatal only if it demands an exact match.
    // That matching rule is not verified here, so report distance and let the
    // reader judge: a colour 2 units away is a rounding artefact, one 90 units
    // away is a hole.
    const declaredList = [...declared.keys()];
    const nearest = (k) => {
      const r = (k >> 16) & 0xff, g = (k >> 8) & 0xff, b = k & 0xff;
      let best = Infinity, bestKey = null;
      for (const d of declaredList) {
        const dist = Math.max(
          Math.abs(((d >> 16) & 0xff) - r),
          Math.abs(((d >> 8) & 0xff) - g),
          Math.abs((d & 0xff) - b));
        if (dist < best) { best = dist; bestKey = d; }
      }
      return { dist: best, key: bestKey };
    };

    const buckets = { exact: 0, near: 0, far: 0 };
    const strays = [];
    for (const [k, c] of counts) {
      const n = nearest(k);
      if (n.dist === 0) { buckets.exact += c; continue; }
      if (n.dist <= 8) buckets.near += c; else buckets.far += c;
      strays.push({ colour: k, count: c, dist: n.dist, nearestKey: n.key, nearestName: declared.get(n.key) });
    }
    strays.sort((a, b) => b.count - a.count);
    const unused = [...declared].filter(([k]) => !counts.has(k));

    if (buckets.far === 0) clean++; else dirty++;
    rows.push({
      body, declared: declared.size, present: counts.size,
      strayCount: strays.length, buckets, total,
      farPct: buckets.far / total * 100,
      nearPct: buckets.near / total * 100,
      top: strays.filter((s) => s.dist > 8).slice(0, opts.max),
      unused,
    });
  }

  console.log('texels by distance to the nearest declared biome colour');
  console.log('BODY          DECLARED  COLOURS     EXACT     NEAR(<=8)      FAR(>8)');
  for (const r of rows) {
    if (r.note) { console.log('  ' + r.body.padEnd(14) + r.note); continue; }
    const pc = (n) => (n / r.total * 100).toFixed(2).padStart(7) + '%';
    console.log('  ' + r.body.padEnd(12) + String(r.declared).padStart(6) +
      String(r.present).padStart(9) + '  ' + pc(r.buckets.exact) + '  ' +
      pc(r.buckets.near) + '  ' + pc(r.buckets.far) +
      (r.buckets.far > 0 ? '   <--' : ''));
  }

  const worst = rows.filter((r) => r.buckets?.far > 0).sort((a, b) => b.farPct - a.farPct);
  if (worst.length) {
    console.log('\ncolours more than 8 units from any declared biome, worst first');
    for (const r of worst) {
      console.log('  ' + r.body + '  (' + r.farPct.toFixed(2) + '% of texels)');
      for (const s of r.top) {
        console.log('      ' + hex(s.colour) + '  ' + (s.count / r.total * 100).toFixed(4) + '%  ' +
          'nearest ' + hex(s.nearestKey) + ' (' + s.nearestName + ') at distance ' + s.dist);
      }
      const more = r.top.length;
      if (r.strayCount > more) console.log('      ... and other colours not listed');
      if (r.unused.length) {
        console.log('      declared but absent from the map: ' +
          r.unused.map(([k, n]) => hex(k) + ' ' + n).join(', '));
      }
    }
  }

  console.log('\n' + clean + ' map(s) with everything within 8 units of a declared biome, ' +
    dirty + ' with colours further away, ' + unknownBody + ' with no definitions found');
  console.log('\nNote: whether a near miss matters depends on how Kopernicus resolves a\n' +
    'texel to a biome (nearest colour vs exact match). That was not verified.');
  process.exit(dirty > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
