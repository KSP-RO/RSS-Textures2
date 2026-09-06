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
//   --dry-run         report what each asset would contain, compress nothing
//
// PROTOTYPE. There is no texture conversion here: files are taken from the
// existing per-set directories as-is. The seam where an encoder goes is
// resolveSource() below. That is deliberate - packaging is the part that is
// currently broken (16384.zip is at 95% of GitHub's per-asset limit and
// build.pl cannot even produce it), and it carries no visual risk.

import { mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { writeZip } from './lib/zipwriter.mjs';
import { expectedFileSize, fullChainLevels } from '../manifest/lib/dds.mjs';

const MIB = 1024 * 1024;
const GITHUB_ASSET_LIMIT = 2048; // MiB

function parseArgs(argv) {
  const o = {
    manifest: 'manifest/textures.json', root: '.', out: 'dist',
    sets: null, all: false, split: 'auto', limit: 1900, level: 6, dryRun: false,
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
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error('unknown option: ' + a);
  }
  if (!['none', 'groups', 'auto'].includes(o.split)) throw new Error('--split must be none, groups or auto');
  return o;
}

/**
 * Where a texture's bytes come from for a given set.
 *
 * Today: the pre-built file in that set's directory. This is the single point
 * a conversion step replaces - it would take the source asset plus the
 * manifest's format/mips/native fields and produce the DDS, rather than
 * looking one up. Everything downstream is unchanged by that swap.
 */
function resolveSource(root, setName, mapName, install) {
  return install === '.'
    ? join(root, setName, mapName + '.dds')
    : join(root, setName, install, mapName + '.dds');
}

/** Path inside the archive. Installs to GameData/RSS-Textures. */
function archivePath(mapName, install) {
  return install === '.'
    ? 'GameData/RSS-Textures/' + mapName + '.dds'
    : 'GameData/RSS-Textures/' + install + '/' + mapName + '.dds';
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** Collect every file that belongs in a set, bucketed by packaging group. */
async function collect(manifest, root, setName) {
  const groups = new Map();
  const missing = [];

  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    const groupName = body.group ?? 'Ungrouped';
    for (const [kind, map] of Object.entries(body.maps)) {
      const mapName = bodyName + kind;
      const install = map.install ?? manifest.kinds[kind].install;
      const source = resolveSource(root, setName, mapName, install);
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
      const bucket = groups.get(groupName) ?? [];
      bucket.push({ source, name: archivePath(mapName, install), bytes: (await stat(source)).size });
      groups.set(groupName, bucket);
    }
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

  return { groups, missing };
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
    const { groups, missing } = await collect(manifest, opts.root, setName);
    const plan = planAssets(setName, groups, opts.split, opts.limit, missing);

    console.log('=== set ' + setName + ' ===');
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
