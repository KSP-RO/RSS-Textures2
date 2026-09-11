#!/usr/bin/env node
// Populate the source cache: every body archive a build needs, plus every DEM.
//
//   node tools/convert/fetch-sources.mjs
//   node tools/convert/fetch-sources.mjs --dry-run
//   node tools/convert/fetch-sources.mjs --sources v0.0.1 --cache .cache/sources
//
//   --sources <tag>   release tag on KSP-RO/RSS-Textures-Source, default latest
//   --cache <dir>     where the assets live, default .cache/sources. Must match
//                     what convert.mjs and heights.mjs use
//   --manifest <file> default manifest/textures.json
//   --dry-run         list what would be fetched and what it weighs. Reads the
//                     release index only, downloads nothing
//
// Why this is its own tool rather than a side effect of converting: the release
// workflow builds three sets in parallel, one runner each, and left to
// themselves all three pull the same 6.04 GiB of body archives and the same
// 1.74 GiB DEM - 23 GiB per run to deliver 7.8 GiB of distinct bytes. They also
// all race to write the same cache entry, so two of them lose and warn.
//
// Fetching once, in a job the builds depend on, makes it one download, and
// makes it impossible for the three sets in a release to be built from
// different source bytes because a new release landed mid-run.
//
// Nothing here is specific to CI. Run it before going offline and every
// subsequent build is local.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listRelease, fetchAsset } from './lib/sources.mjs';

function parseArgs(argv) {
  const o = {
    sources: 'latest', cache: join('.cache', 'sources'),
    manifest: 'manifest/textures.json', dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sources') o.sources = argv[++i];
    else if (a === '--cache') o.cache = argv[++i];
    else if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error('unknown option: ' + a);
  }
  return o;
}

const mib = (n) => (n / 1048576).toFixed(1);
const size = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GiB' : mib(n) + ' MiB');

/**
 * Everything a build pulls from the release.
 *
 * Body archives are matched the way convert.mjs matches them - the manifest
 * decides, so a release carrying a body the pack does not declare is not
 * downloaded. DEMs come from the heightmaps that declare a topoconv spec,
 * which is what heights.mjs fetches.
 */
function plan(manifest, rel) {
  const wanted = [];
  const problems = [];

  for (const body of Object.keys(manifest.bodies)) {
    const entry = rel.bodies.get(body.toLowerCase());
    if (entry) wanted.push({ what: entry.body, kind: 'body', entry });
  }

  const demIds = new Set();
  for (const body of Object.values(manifest.bodies)) {
    const id = body.maps?.Height?.topoconv?.dem;
    if (id) demIds.add(id);
  }
  for (const id of demIds) {
    const dem = manifest.dems?.[id];
    if (!dem?.asset) {
      problems.push('DEM "' + id + '" has no "asset" field in the manifest');
      continue;
    }
    const entry = rel.assets.get(dem.asset);
    if (!entry) {
      problems.push('release ' + rel.tag + ' has no asset "' + dem.asset + '" for DEM "' + id + '"');
      continue;
    }
    // The same check heights.mjs makes, made here instead: a wrong DEM should
    // fail in the cheap shared job, not three times over after a 1.74 GiB
    // download each.
    if (dem.bytes && entry.size !== dem.bytes) {
      problems.push('release asset ' + dem.asset + ' is ' + entry.size +
        ' bytes, manifest expects ' + dem.bytes + ' - wrong file, or a different revision');
      continue;
    }
    wanted.push({ what: id, kind: 'dem', entry });
  }

  return { wanted, problems };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));
  const rel = await listRelease(opts.sources);

  const { wanted, problems } = plan(manifest, rel);
  if (problems.length) throw new Error(problems.join('\n'));

  const total = wanted.reduce((n, w) => n + w.entry.size, 0);
  console.log('source release ' + rel.tag + ': ' + wanted.length + ' asset(s), ' + size(total));
  console.log('cache ' + opts.cache + '\n');

  if (opts.dryRun) {
    for (const w of wanted.sort((a, b) => b.entry.size - a.entry.size)) {
      console.log('  ' + w.kind.padEnd(5) + w.what.padEnd(14) +
        mib(w.entry.size).padStart(9) + ' MiB  ' + w.entry.asset);
    }
    console.log('\n(dry run - nothing downloaded)');
    return;
  }

  let downloaded = 0, cachedBytes = 0;
  // Serially, not in parallel: this saturates a runner's link on its own, and
  // a partially written cache entry is worse than a slow one.
  for (const w of wanted) {
    const { path, cached } = await fetchAsset(w.entry, opts.cache);
    if (cached) cachedBytes += w.entry.size; else downloaded += w.entry.size;
    console.log('  ' + (cached ? 'cached    ' : 'downloaded') + ' ' +
      w.what.padEnd(14) + mib(w.entry.size).padStart(9) + ' MiB  ' + path);
  }

  console.log('\ndownloaded ' + size(downloaded) + ', already cached ' + size(cachedBytes));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
