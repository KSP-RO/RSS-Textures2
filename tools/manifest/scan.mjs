#!/usr/bin/env node
// Scan the texture sets and record what is actually on disk.
//
//   node tools/manifest/scan.mjs [options]
//
//   --root <dir>        repo root (default: cwd)
//   --out <file>        write observed model as JSON
//   --release <tag>     also recover the 16k files that are too large for git,
//                       by reading the central directory of that release's
//                       16384.zip over HTTP range requests (use "latest")
//   --alpha             probe DXT5 alpha channels (reads every DXT5 file)
//   --nrm               probe DXT5nm filler convention
//   --hash              record sha256 per file, for byte-exact rebuild checks
//   --quiet             suppress the table, just write --out
//
// Output is a plain observation of reality, with no opinion about what the
// files ought to be. verify.mjs is what compares this against the manifest.

import { readdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  readHeader, dxt5AlphaIsOpaque, dxt5nmFiller,
  identifyBySize, candidateGeometries,
} from './lib/dds.mjs';
import { readZipDirectory, findReleaseAsset } from './lib/zip.mjs';
import { SETS, parseSets } from './lib/sets.mjs';
import { splitMapName } from './lib/mapname.mjs';

const REPO = 'KSP-RO/RSS-Textures';

function parseArgs(argv) {
  const opts = {
    root: process.cwd(), out: null, release: null,
    alpha: false, nrm: false, hash: false, quiet: false, sets: SETS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--release') opts.release = argv[++i];
    else if (a === '--sets') opts.sets = parseSets(argv[++i]);
    else if (a === '--alpha') opts.alpha = true;
    else if (a === '--nrm') opts.nrm = true;
    else if (a === '--hash') opts.hash = true;
    else if (a === '--quiet') opts.quiet = true;
    else throw new Error('unknown option: ' + a);
  }
  return opts;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

/**
 * Where a texture installs relative to GameData/RSS-Textures.
 * "." is the mod root (always-loaded home-system textures); everything else
 * lives in PluginData so Kopernicus can load it on demand.
 */
function installDir(root, setName, filePath) {
  const rel = relative(join(root, setName), filePath).split(sep);
  return rel.length > 1 ? rel.slice(0, -1).join('/') : '.';
}

async function scanSet(root, setName, opts) {
  const found = {};
  for await (const file of walk(join(root, setName))) {
    if (!file.toLowerCase().endsWith('.dds')) continue;
    const header = await readHeader(file);
    const base = file.split(sep).pop().replace(/\.dds$/i, '');
    if (!header) {
      found[base] = { error: 'not a DDS file' };
      continue;
    }
    const rec = {
      width: header.width,
      height: header.height,
      format: header.format,
      mips: header.mips,
      levels: header.levels,
      declaredLevels: header.declaredLevels,
      install: installDir(root, setName, file),
      bytes: header.bytes,
    };
    if (header.expectedBytes !== null && header.expectedBytes !== header.bytes) {
      rec.sizeMismatch = { expected: header.expectedBytes, actual: header.bytes };
    }
    if (opts.alpha && header.format === 'DXT5') {
      rec.alphaOpaque = await dxt5AlphaIsOpaque(file, header.width, header.height);
    }
    if (opts.nrm && header.format === 'DXT5' && base.endsWith('_NRM')) {
      rec.nrmFiller = await dxt5nmFiller(file, header.width, header.height);
    }
    if (opts.hash) rec.sha256 = await sha256(file);
    found[base] = rec;
  }
  return found;
}

/**
 * Recover the textures that are absent from git because they exceed GitHub's
 * 100 MiB file limit, using the published release. We only learn size and path
 * from the zip directory, but for a DDS that is enough to pin down format,
 * dimensions and mip count exactly.
 */
async function scanRelease(tag, existing) {
  const asset = await findReleaseAsset(REPO, tag, '16384.zip');
  const { entries } = await readZipDirectory(asset.url);
  const recovered = {};
  const unidentified = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith('.dds')) continue;
    const base = entry.name.split('/').pop().replace(/\.dds$/i, '');
    if (existing[base]) continue; // already have the real file locally
    const { kind } = splitMapName(base);
    const geom = identifyBySize(entry.uncompressedSize, candidateGeometries(16384, kind));
    if (!geom) {
      unidentified.push({ name: base, bytes: entry.uncompressedSize });
      continue;
    }
    recovered[base] = {
      width: geom.width,
      height: geom.height,
      format: geom.format,
      mips: geom.mips,
      levels: geom.levels,
      install: entry.name.includes('/PluginData/') ? 'PluginData' : '.',
      bytes: entry.uncompressedSize,
      zipBytes: entry.compressedSize,
      source: 'release:' + asset.tag,
      note: 'exceeds GitHub file size limit; present only in the release zip',
    };
  }
  return { recovered, unidentified, tag: asset.tag, assetBytes: asset.size };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const setNames = opts.sets;
  const sets = {};
  for (const s of setNames) sets[s] = await scanSet(opts.root, s, opts);

  let release = null;
  if (opts.release && setNames.includes('16384')) {
    const r = await scanRelease(opts.release, sets['16384']);
    Object.assign(sets['16384'], r.recovered);
    release = {
      tag: r.tag,
      assetBytes: r.assetBytes,
      recovered: Object.keys(r.recovered).sort(),
      unidentified: r.unidentified,
    };
  }

  // Pivot from set -> map into map -> set, which is how the manifest thinks.
  const maps = {};
  for (const s of setNames) {
    for (const [name, rec] of Object.entries(sets[s])) {
      const { body, kind } = splitMapName(name);
      const m = (maps[name] ??= { body, kind, sets: {} });
      m.sets[s] = rec;
    }
  }

  const model = {
    generatedAt: new Date().toISOString(),
    root: opts.root,
    setNames,
    release,
    maps,
  };

  if (opts.out) {
    await writeFile(opts.out, JSON.stringify(model, null, 2) + '\n');
    if (!opts.quiet) console.log('wrote ' + opts.out);
  }
  if (opts.quiet) return;

  const pad = (v, n) => String(v).padEnd(n);
  console.log(
    pad('MAP', 20) + pad('KIND', 9) +
    setNames.map((s) => pad(s, 8)).join('') + pad('FORMATS', 14) + 'MIPS',
  );
  console.log('-'.repeat(96));
  for (const [name, m] of Object.entries(maps).sort(([a], [b]) => a.localeCompare(b))) {
    const cells = setNames.map((s) => m.sets[s]);
    const formats = [...new Set(cells.filter(Boolean).map((c) => c.format))];
    const mips = [...new Set(cells.filter(Boolean).map((c) => c.mips))];
    console.log(
      pad(name, 20) + pad(m.kind, 9) +
      cells.map((c) => pad(c ? c.width : '-', 8)).join('') +
      pad(formats.join(','), 14) + mips.join(','),
    );
  }
  const total = Object.values(maps).reduce((n, m) => n + Object.keys(m.sets).length, 0);
  console.log('\n' + Object.keys(maps).length + ' maps, ' + total + ' files across ' + setNames.length + ' sets');
  if (release) {
    console.log('recovered from release ' + release.tag + ': ' + release.recovered.length + ' files');
    if (release.unidentified.length) {
      console.log('could not identify by size: ' +
        release.unidentified.map((u) => u.name + ' (' + u.bytes + ' B)').join(', '));
    }
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
