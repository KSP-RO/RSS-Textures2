#!/usr/bin/env node
// Build release packages from the manifest.
//
//   node tools/build/build.mjs --set 8192 --out dist
//   node tools/build/build.mjs --all --split groups --dry-run
//
//   --set <name>      build one set (4096 / 8192 / 16384)
//   --all             build every set in the manifest
//   --out <dir>       output directory (default: dist)
//   --split <mode>    none    one asset per set, as today
//                     groups  one asset per planetary system
//                     auto    split only when a single asset would exceed
//                             --limit (default)
//   --limit <MiB>     split threshold, default 1900 (GitHub's cap is 2048)
//   --level <0-9>     deflate level, default 6
//   --overlay <dir>   prefer files from this root (laid out like the repo,
//                     with 4096/ 8192/ ... subdirectories) over the checkout.
//                     This is how convert.mjs output reaches a release.
//   --overlay-report <file>
//                     a convert.mjs --report file. Every map it claims to have
//                     built must be present in the overlay, or the build fails
//                     rather than silently falling back to the checkout.
//   --dry-run         report what each asset would contain, compress nothing
//
// This does not convert anything itself. Without --overlay it packages the DDS
// already in the checkout, which is byte-identical to what shipped last time
// and carries no visual risk. With --overlay it prefers converted files and
// falls back to the checkout for everything conversion could not produce:
//
//   node tools/convert/convert.mjs --set 4096 --sources latest --out build/4096
//   node tools/build/build.mjs --set 4096 --overlay build --out dist
//
// That two-step split is deliberate. Conversion needs sources, an encoder and
// network; packaging needs none of those, so a release can still be cut when
// conversion is not wanted or not possible.

import { mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { writeZip } from './lib/zipwriter.mjs';
import { expectedFileSize, fullChainLevels } from '../manifest/lib/dds.mjs';
import { splitMapName } from '../manifest/lib/mapname.mjs';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

const MIB = 1024 * 1024;
const GITHUB_ASSET_LIMIT = 2048; // MiB

function parseArgs(argv) {
  const o = {
    manifest: 'manifest/textures.json', root: '.', out: 'dist',
    sets: null, all: false, split: 'auto', limit: 1900, level: 6, dryRun: false,
    overlay: null, overlayReport: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--set') (o.sets ??= []).push(argv[++i]);
    else if (a === '--all') o.all = true;
    else if (a === '--split') o.split = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--level') o.level = Number(argv[++i]);
    else if (a === '--overlay') o.overlay = argv[++i];
    else if (a === '--overlay-report') o.overlayReport = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error('unknown option: ' + a);
  }
  if (!['none', 'groups', 'auto'].includes(o.split)) throw new Error('--split must be none, groups or auto');
  return o;
}

function setPath(root, setName, mapName, install) {
  return install === '.'
    ? join(root, setName, mapName + '.dds')
    : join(root, setName, install, mapName + '.dds');
}

/**
 * Where a texture's bytes come from for a given set.
 *
 * An overlay root wins over the repository's own set directory. That is how
 * conversion output gets into a release: convert.mjs writes the maps it has
 * sources for, and everything it could not produce falls back to the file that
 * already ships.
 *
 * The fallback is the point. The source set is partial - 13 of 33 bodies in
 * v0.0.1, several of those incomplete - so a release built purely from sources
 * would be missing most of the solar system. Mixing is the only way forward
 * until sources are complete, and the build reports the split so a release is
 * never quietly half-converted without anyone noticing.
 */
async function resolveSource(root, overlay, setName, mapName, install) {
  if (overlay) {
    const candidate = setPath(overlay, setName, mapName, install);
    if (await exists(candidate)) return { path: candidate, from: 'overlay' };
  }
  return { path: setPath(root, setName, mapName, install), from: 'repo' };
}

/**
 * Cross-check the overlay against the conversion report.
 *
 * Silent fallback is the hazard here. If conversion dies partway - and a large
 * decode getting killed by the OS produces no output at all - the overlay is
 * simply smaller, every missing map quietly falls back to the checkout, and
 * the build succeeds having published a half-converted pack that nobody
 * ordered. The report says what conversion believed it produced; if the
 * overlay does not match, that is a failure, not a fallback.
 */
async function checkOverlayAgainstReport(reportPath, overlay, setName, manifest) {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (report.set !== setName) {
    throw new Error(reportPath + ' is for set ' + report.set + ', not ' + setName);
  }
  const absent = [];
  for (const entry of report.built ?? []) {
    const { body, kind } = splitMapName(entry.mapName);
    const install = manifest.bodies[body]?.maps?.[kind]?.install ?? manifest.kinds[kind]?.install;
    if (!install) continue;
    if (!(await exists(setPath(overlay, setName, entry.mapName, install)))) absent.push(entry.mapName);
  }
  if (absent.length) {
    throw new Error(
      'conversion reported building ' + (report.built ?? []).length + ' map(s) but ' +
      absent.length + ' are not in the overlay: ' + absent.join(', ') + '\n' +
      'The overlay is incomplete; refusing to package a partial conversion.');
  }
  return (report.built ?? []).length;
}

/** Path inside the archive. Installs to GameData/RSS-Textures. */
function archivePath(mapName, install) {
  return install === '.'
    ? 'GameData/RSS-Textures/' + mapName + '.dds'
    : 'GameData/RSS-Textures/' + install + '/' + mapName + '.dds';
}

/** Collect every file that belongs in a set, bucketed by packaging group. */
async function collect(manifest, root, overlay, setName) {
  const groups = new Map();
  const missing = [];
  const fromOverlay = [];
  const shared = [];

  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    const groupName = body.group ?? 'Ungrouped';
    for (const [kind, map] of Object.entries(body.maps)) {
      const mapName = bodyName + kind;
      const install = map.install ?? manifest.kinds[kind].install;
      const { path: source, from } = await resolveSource(root, overlay, setName, mapName, install);
      if (!(await exists(source))) {
        // Size it from the manifest so the split decision still sees roughly
        // the right total. The 16384 set is short its 17 largest textures in a
        // checkout; ignoring them would size it at a third of reality.
        const cap = Number(setName);
        const [nw, nh] = map.native;
        const scale = Math.min(1, cap / nw);
        const w = Math.max(1, Math.round(nw * scale));
        const h = Math.max(1, Math.round(nh * scale));
        const levels = map.mips === 'full' ? fullChainLevels(w, h) : 1;
        missing.push({
          map: mapName, set: setName, source,
          expectedBytes: expectedFileSize(map.format, w, h, levels),
        });
        continue;
      }
      if (from === 'overlay') fromOverlay.push(mapName);
      const bucket = groups.get(groupName) ?? [];
      bucket.push({ source, name: archivePath(mapName, install), bytes: (await stat(source)).size });
      groups.set(groupName, bucket);
    }
  }

  // Textures that belong to no body go into every asset, for the same reason
  // the README does: a user who takes only some groups must still get them.
  // Flat_NRM is the placeholder normal map ten RSS configs point at; when it
  // was modelled as a body called "Flat" it landed in exactly one group, so
  // which groups you installed decided whether you got it.
  for (const [mapName, map] of Object.entries(manifest.shared ?? {})) {
    const install = map.install ?? 'PluginData';
    const { path: source, from } = await resolveSource(root, overlay, setName, mapName, install);
    if (!(await exists(source))) {
      missing.push({
        map: mapName, set: setName, source,
        expectedBytes: expectedFileSize(map.format, map.native[0], map.native[1],
          map.mips === 'full' ? fullChainLevels(map.native[0], map.native[1]) : 1),
      });
      continue;
    }
    if (from === 'overlay') fromOverlay.push(mapName);
    const bytes = (await stat(source)).size;
    for (const bucket of groups.values()) {
      bucket.push({ source, name: archivePath(mapName, install), bytes });
    }
    shared.push(mapName);
  }

  // Documentation ships in every asset, so a partial download is still
  // self-describing and still carries its licence terms.
  for (const doc of ['README.txt']) {
    const p = join(root, doc);
    if (!(await exists(p))) continue;
    for (const bucket of groups.values()) {
      bucket.push({ source: p, name: 'GameData/RSS-Textures/' + doc, bytes: (await stat(p)).size });
    }
  }

  return { groups, missing, fromOverlay, shared };
}

/**
 * Decide how to divide a set into assets.
 *
 * "auto" only splits when the combined size would breach the limit, which
 * keeps the smaller packs as single assets and so leaves the existing CKAN
 * krefs for those untouched.
 */
function planAssets(setName, groups, split, limitMiB, missing) {
  const all = [...groups.values()].flat();
  const measured = all.reduce((n, f) => n + f.bytes, 0);
  const inferred = missing.reduce((n, m) => n + (m.expectedBytes ?? 0), 0);

  // Compressed size is unknown before compressing. The v18.6.1 assets came out
  // at 48% of raw, so use that to decide, and report actuals afterwards.
  const estimatedMiB = ((measured + inferred) * 0.48) / MIB;
  const note = missing.length
    ? 'estimate includes ' + missing.length + ' file(s) sized from the manifest, not measured'
    : null;

  const wantSplit = split === 'groups' || (split === 'auto' && estimatedMiB > limitMiB);
  if (!wantSplit) {
    return { split: false, estimatedMiB, note, assets: [{ name: setName + '.zip', files: all }] };
  }
  const assets = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupName, files]) => ({ name: 'RSS-Textures-' + setName + '-' + groupName + '.zip', files, group: groupName }));
  return { split: true, estimatedMiB, note, assets };
}

const fmt = (bytes) => (bytes / MIB).toFixed(1).padStart(8) + ' MiB';

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));
  const setNames = opts.all ? Object.keys(manifest.sets) : (opts.sets ?? []);
  if (setNames.length === 0) throw new Error('nothing to build: pass --set <name> or --all');
  for (const s of setNames) {
    if (!manifest.sets[s]) throw new Error('set ' + s + ' is not in the manifest (have: ' + Object.keys(manifest.sets).join(', ') + ')');
  }

  if (!opts.dryRun) {
    await rm(opts.out, { recursive: true, force: true });
    await mkdir(opts.out, { recursive: true });
  }

  const summary = [];
  for (const setName of setNames) {
    if (opts.overlayReport) {
      const n = await checkOverlayAgainstReport(opts.overlayReport, opts.overlay, setName, manifest);
      console.log('=== set ' + setName + ' ===');
      console.log('  overlay matches its conversion report (' + n + ' map(s))');
    }
    const { groups, missing, fromOverlay, shared } = await collect(manifest, opts.root, opts.overlay, setName);
    const plan = planAssets(setName, groups, opts.split, opts.limit, missing);

    if (!opts.overlayReport) console.log('=== set ' + setName + ' ===');
    if (shared.length) console.log('  ' + shared.length + ' shared texture(s) in every asset: ' + shared.join(', '));
    if (opts.overlay) {
      console.log('  ' + fromOverlay.length + ' map(s) taken from the overlay, the rest from the checkout');
      if (fromOverlay.length) console.log('    ' + fromOverlay.sort().join(', '));
    }
    if (missing.length) {
      console.log('  ' + missing.length + ' file(s) absent from the checkout, omitted:');
      for (const m of missing.slice(0, 20)) console.log('    ' + m.map);
      if (missing.length > 20) console.log('    ... and ' + (missing.length - 20) + ' more');
    }
    console.log('  ' + plan.assets.length + ' asset(s), split=' + plan.split +
      ' (estimated ' + plan.estimatedMiB.toFixed(0) + ' MiB combined)');
    if (plan.note) console.log('  ' + plan.note);

    for (const asset of plan.assets) {
      const raw = asset.files.reduce((n, f) => n + f.bytes, 0);
      if (opts.dryRun) {
        console.log('    ' + asset.name.padEnd(40) + String(asset.files.length).padStart(4) + ' files' + fmt(raw) + ' raw');
        summary.push({ set: setName, asset: asset.name, files: asset.files.length, rawBytes: raw, zipBytes: null });
        continue;
      }
      const outPath = join(opts.out, asset.name);
      await mkdir(dirname(outPath), { recursive: true });
      const r = await writeZip(outPath, asset.files, { level: opts.level });
      const pct = ((r.zipBytes / MIB) / GITHUB_ASSET_LIMIT * 100).toFixed(0);
      const warn = r.zipBytes / MIB > opts.limit ? '  <-- OVER --limit' : '';
      console.log('    ' + asset.name.padEnd(40) + String(r.entries).padStart(4) + ' files' +
        fmt(r.rawBytes) + ' raw ->' + fmt(r.zipBytes) + ' zip  (' + pct + '% of GitHub cap)' + warn);
      summary.push({ set: setName, asset: asset.name, files: r.entries, rawBytes: r.rawBytes, zipBytes: r.zipBytes });
    }
    console.log('');
  }

  if (!opts.dryRun) {
    await writeFile(join(opts.out, 'build-summary.json'), JSON.stringify({ builtAt: null, summary }, null, 2) + '\n');
  }

  const over = summary.filter((s) => s.zipBytes && s.zipBytes / MIB > GITHUB_ASSET_LIMIT);
  if (over.length) {
    console.log('FAILED - ' + over.length + ' asset(s) exceed the GitHub 2 GiB limit:');
    for (const s of over) console.log('  ' + s.asset + ' ' + (s.zipBytes / MIB).toFixed(0) + ' MiB');
    process.exit(1);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
