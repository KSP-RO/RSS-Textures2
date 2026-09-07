#!/usr/bin/env node
// Fetch the Compressonator CLI for this platform.
//
//   node tools/convert/get-compressonator.mjs            # into tools/.bin
//   node tools/convert/get-compressonator.mjs --print    # just print the path
//   node tools/convert/get-compressonator.mjs --dir X --version 4.5.52
//
// The version is pinned. A texture encoder is not a dependency you want
// floating: a new release can change block selection and silently alter every
// colour map in the pack. Bumping it is a deliberate act with a visual diff,
// which is what manifest/baseline.json is for.

import { mkdir, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readZipDirectory } from '../manifest/lib/zip.mjs';
import { extractEntry } from './lib/sources.mjs';
import { readFile } from 'node:fs/promises';

const REPO = 'GPUOpen-Tools/compressonator';
const VERSION = '4.5.52';

// Asset name and the executable inside it, per platform.
const PLATFORMS = {
  linux: { asset: (v) => 'compressonatorcli-' + v + '-Linux.tar.gz', exe: 'compressonatorcli' },
  win32: { asset: (v) => 'compressonatorcli-' + v + '-win64.zip', exe: 'compressonatorcli.exe' },
};

function parseArgs(argv) {
  const o = { dir: join('tools', '.bin'), version: VERSION, print: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') o.dir = argv[++i];
    else if (argv[i] === '--version') o.version = argv[++i];
    else if (argv[i] === '--print') o.print = true;
    else if (argv[i] === '--force') o.force = true;
    else throw new Error('unknown option: ' + argv[i]);
  }
  return o;
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** Depth-first search for the executable, wherever the archive nested it. */
async function findExe(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === name.toLowerCase()) return full;
    }
  }
  return null;
}

async function resolveAsset(version, assetName) {
  const url = 'https://api.github.com/repos/' + REPO + '/releases/tags/V' + version;
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('GitHub API ' + res.status + ' for ' + url);
  const release = await res.json();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error('asset ' + assetName + ' not in ' + release.tag_name +
      ' (have: ' + release.assets.map((a) => a.name).join(', ') + ')');
  }
  return asset;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plat = PLATFORMS[process.platform];
  if (!plat) {
    throw new Error('no Compressonator build configured for ' + process.platform +
      '; set COMPRESSONATOR to a binary you installed yourself');
  }

  const dest = resolve(opts.dir, 'compressonator-' + opts.version);
  const existing = await findExe(dest, plat.exe);
  if (existing && !opts.force) {
    if (!opts.print) console.log('already present: ' + existing);
    else console.log(existing);
    return;
  }

  const assetName = plat.asset(opts.version);
  const asset = await resolveAsset(opts.version, assetName);
  await mkdir(dest, { recursive: true });

  const archive = join(dest, assetName);
  if (!(await exists(archive))) {
    if (!opts.print) console.log('downloading ' + assetName + ' (' + (asset.size / 1048576).toFixed(1) + ' MiB)');
    const res = await fetch(asset.browser_download_url, { redirect: 'follow' });
    if (!res.ok) throw new Error('download failed ' + res.status);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
  }

  if (assetName.endsWith('.tar.gz')) {
    // tar is present on every runner and on Windows 10+, and unlike a
    // hand-rolled extractor it preserves the executable bit, which the Linux
    // build needs to run at all.
    const r = spawnSync('tar', ['-xzf', archive, '-C', dest], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('tar failed: ' + (r.stderr || r.stdout));
  } else {
    const buf = await readFile(archive);
    const { entries } = await readZipDirectory(archive);
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      const out = join(dest, entry.name);
      await mkdir(join(out, '..'), { recursive: true });
      await writeFile(out, extractEntry(buf, entry));
    }
  }
  await rm(archive, { force: true });

  const exe = await findExe(dest, plat.exe);
  if (!exe) throw new Error('extracted ' + assetName + ' but found no ' + plat.exe + ' under ' + dest);

  // Run it before declaring success. On Linux `compressonatorcli` is a bash
  // wrapper that sets LD_LIBRARY_PATH and execs compressonatorcli-bin against
  // libraries bundled in pkglibs - OpenCV 3.2 and IlmImf 2.2, which are from
  // the Ubuntu 18.04 era. If those fail to load on a newer runner it must fail
  // here, loudly, rather than at the first texture.
  const check = spawnSync(exe, ['-version'], { encoding: 'utf8' });
  const failed = check.error || check.status !== 0;
  if (failed) {
    const detail = check.error ? check.error.message : (check.stderr || check.stdout || 'exit ' + check.status);
    throw new Error(
      'extracted ' + exe + ' but it will not run: ' + String(detail).trim() + '\n' +
      'The Linux tarball bundles old shared libraries. If they do not load on this\n' +
      'distribution, either install the .deb instead:\n' +
      '  sudo apt-get install -y ./compressonatorcli_' + opts.version + '_amd64.deb\n' +
      'or pin the workflow to an older runner image (ubuntu-22.04).');
  }
  const reported = (check.stdout || check.stderr || '').split(/\r?\n/).find((l) => l.trim())?.trim();

  if (opts.print) { console.log(exe); return; }
  console.log('installed ' + exe);
  console.log('reports: ' + (reported || '(no version output)'));
  console.log('\nexport COMPRESSONATOR=' + exe);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
