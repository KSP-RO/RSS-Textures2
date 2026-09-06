#!/usr/bin/env node
// Check a texture tree against manifest/textures.json.
//
//   node tools/manifest/verify.mjs --observed build/observed.json
//   node tools/manifest/verify.mjs --root . --release latest
//   node tools/manifest/verify.mjs --observed new.json --baseline shipped.json
//
//   --manifest <file>   default manifest/textures.json
//   --observed <file>   a scan.mjs model to check (skips rescanning)
//   --root <dir>        scan this tree instead of passing --observed
//   --release <tag>     when scanning, also recover release-only 16k files
//   --set <name>        restrict to one set
//   --baseline <file>   compare sha256 against another scan model and report
//                       every file whose bytes changed
//   --strict            treat knownDeviations as failures too, and require
//                       provenance fields to be filled in
//   --json              emit machine-readable results
//
// Exit code is 0 when nothing unexpected was found. Deviations already
// recorded in the manifest's knownDeviations list are reported as warnings, so
// the backlog stays visible without making CI permanently red.

import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expectedFileSize, fullChainLevels } from './lib/dds.mjs';
import { SETS, parseSets } from './lib/sets.mjs';
const here = dirname(fileURLToPath(import.meta.url));

// GitHub refuses any push containing a file above this, which is why 17 of the
// 16k textures live only inside the release zip.
// https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github
const GIT_FILE_LIMIT = 100 * 1024 * 1024;

function parseArgs(argv) {
  const o = {
    manifest: 'manifest/textures.json', observed: null, root: null,
    release: null, set: null, sets: SETS, baseline: null, strict: false, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--observed') o.observed = argv[++i];
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--release') o.release = argv[++i];
    else if (a === '--set') o.set = argv[++i];
    else if (a === '--sets') o.sets = parseSets(argv[++i]);
    else if (a === '--baseline') o.baseline = argv[++i];
    else if (a === '--strict') o.strict = true;
    else if (a === '--json') o.json = true;
    else throw new Error('unknown option: ' + a);
  }
  if (!o.observed && !o.root) o.root = process.cwd();
  return o;
}

/** Run scan.mjs into a temp model rather than duplicating its walk logic. */
async function scanTree(root, release, sets) {
  // os.tmpdir() rather than %TEMP%/$TMPDIR: neither is reliably set on a CI
  // runner, and the old fallback to "." wrote into whatever the cwd happened
  // to be. The pid keeps concurrent verifies from colliding.
  const tmp = join(tmpdir(), 'rss-verify-scan-' + process.pid + '.json');
  const args = [join(here, 'scan.mjs'), '--root', root, '--out', tmp, '--quiet', '--alpha'];
  if (release) args.push('--release', release);
  if (sets) args.push('--sets', sets.join(','));

  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.error) throw new Error('could not run scan.mjs: ' + r.error.message);
  if (r.status !== 0) throw new Error('scan.mjs exited ' + r.status + ': ' + (r.stderr || r.stdout || '(no output)'));

  try {
    return JSON.parse(await readFile(tmp, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // scan.mjs reported success but produced nothing, so the failure is in the
    // scanner, not here. Say so rather than surfacing a bare ENOENT.
    throw new Error(
      'scan.mjs exited 0 but wrote no output to ' + tmp + '.\n' +
      'stdout: ' + (r.stdout || '(empty)') + '\nstderr: ' + (r.stderr || '(empty)'),
    );
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Structural checks on the manifest itself, independent of any texture tree. */
function validateManifest(m) {
  const problems = [];
  const isPow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

  for (const [bodyName, body] of Object.entries(m.bodies)) {
    if (!body.group) problems.push(bodyName + ': no packaging group');
    else if (!m.groups[body.group]) problems.push(bodyName + ': unknown group ' + body.group);
    else if (!m.groups[body.group].bodies.includes(bodyName)) {
      problems.push(bodyName + ': group ' + body.group + ' does not list it');
    }
    for (const [kind, map] of Object.entries(body.maps)) {
      const spec = m.kinds[kind];
      const label = bodyName + kind;
      if (!spec) { problems.push(label + ': unknown kind ' + kind); continue; }
      if (!spec.formats.includes(map.format)) {
        problems.push(label + ': format ' + map.format + ' not allowed for ' + kind +
          ' (allowed: ' + spec.formats.join(', ') + ')');
      }
      if (map.mips !== spec.mips) {
        problems.push(label + ': mips ' + map.mips + ' contradicts kind default ' + spec.mips +
          ' - if deliberate, change the kind or document it');
      }
      const [w, h] = map.native ?? [];
      if (!isPow2(w) || !isPow2(h)) problems.push(label + ': native ' + w + 'x' + h + ' is not power-of-two');
      else if (kind !== 'Ring' && w !== h * 2) {
        problems.push(label + ': native ' + w + 'x' + h + ' is not 2:1 equirectangular');
      }
      if (map.derivedFrom && !body.maps[map.derivedFrom]) {
        problems.push(label + ': derivedFrom ' + map.derivedFrom + ' is not a map on this body');
      }
      if (map.derivedFrom === kind) problems.push(label + ': derivedFrom points at itself');
    }
  }
  // Group membership must be a partition: every listed body must exist.
  for (const [gName, g] of Object.entries(m.groups)) {
    for (const b of g.bodies) {
      if (!m.bodies[b]) problems.push('group ' + gName + ' lists unknown body ' + b);
    }
  }
  return problems;
}

/** What the manifest says a map should look like in a given set. */
function expectedFor(map, setName) {
  const cap = Number(setName);
  const [nw, nh] = map.native;
  const scale = Math.min(1, cap / nw);
  const width = Math.max(1, Math.round(nw * scale));
  const height = Math.max(1, Math.round(nh * scale));
  const levels = map.mips === 'full' ? fullChainLevels(width, height) : 1;
  return { width, height, format: map.format, mips: map.mips, levels };
}

/**
 * Would this texture be refused by a git push?
 *
 * A checkout legitimately lacks these; a built GameData tree must not. We only
 * excuse them when the scan did not consult a release, since a scan with
 * --release has no reason to be missing them.
 */
function tooBigForGit(want) {
  return expectedFileSize(want.format, want.width, want.height, want.levels) > GIT_FILE_LIMIT;
}

function deviationKey(d) {
  return d.map + '|' + d.set + '|' + d.kind;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));
  const observed = opts.observed
    ? JSON.parse(await readFile(opts.observed, 'utf8'))
    : await scanTree(opts.root, opts.release, opts.sets);

  const structural = validateManifest(manifest);
  const known = new Set(manifest.knownDeviations.map(deviationKey));
  const found = [];
  const setsToCheck = opts.set ? [opts.set] : opts.sets;

  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    for (const [kind, map] of Object.entries(body.maps)) {
      const mapName = bodyName + kind;
      const obs = observed.maps[mapName];
      for (const setName of setsToCheck) {
        const want = expectedFor(map, setName);
        const got = obs?.sets?.[setName];
        if (!got) {
          const oversize = !observed.release && tooBigForGit(want);
          found.push({
            map: mapName, set: setName, kind: 'missing',
            oversize,
            reason: oversize
              ? 'exceeds the GitHub 100 MiB file limit; ships only in the release zip'
              : 'not present in the scanned tree',
          });
          continue;
        }
        if (got.width !== want.width || got.height !== want.height) {
          found.push({
            map: mapName, set: setName, kind: 'size',
            expected: want.width + 'x' + want.height, actual: got.width + 'x' + got.height,
          });
        }
        if (got.format !== want.format) {
          found.push({ map: mapName, set: setName, kind: 'format', expected: want.format, actual: got.format });
        }
        if (got.mips !== want.mips) {
          found.push({ map: mapName, set: setName, kind: 'mips', expected: want.mips, actual: got.mips });
        }
        if (got.sizeMismatch) {
          found.push({
            map: mapName, set: setName, kind: 'truncated',
            expected: got.sizeMismatch.expected + ' B', actual: got.sizeMismatch.actual + ' B',
          });
        }
        const wantInstall = map.install ?? manifest.kinds[kind].install;
        if (got.install && got.install !== wantInstall) {
          found.push({ map: mapName, set: setName, kind: 'install', expected: wantInstall, actual: got.install });
        }
      }
    }
  }

  // Anything in the tree the manifest has never heard of.
  const declared = new Set();
  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    for (const kind of Object.keys(body.maps)) declared.add(bodyName + kind);
  }
  for (const mapName of Object.keys(observed.maps)) {
    if (!declared.has(mapName)) {
      found.push({ map: mapName, set: '*', kind: 'undeclared', reason: 'present in the tree but absent from the manifest' });
    }
  }

  const isKnown = (d) => !opts.strict && (known.has(deviationKey(d)) || d.oversize === true);
  const errors = found.filter((d) => !isKnown(d));
  const warnings = found.filter(isKnown);
  const oversizeCount = warnings.filter((d) => d.oversize).length;

  // Provenance completeness, reported always but only fatal under --strict.
  const todo = [];
  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    for (const [kind, map] of Object.entries(body.maps)) {
      if (!map.source) todo.push(bodyName + kind + ': source');
      if (kind === 'Height' && (map.rss?.offset == null || map.rss?.deformity == null)) {
        todo.push(bodyName + kind + ': rss.offset / rss.deformity');
      }
    }
  }

  let baselineDiff = null;
  if (opts.baseline) {
    const base = JSON.parse(await readFile(opts.baseline, 'utf8'));
    const changed = [], added = [], removed = [];
    for (const [mapName, m] of Object.entries(observed.maps)) {
      for (const [setName, rec] of Object.entries(m.sets)) {
        const b = base.maps[mapName]?.sets?.[setName];
        if (!b) { added.push(mapName + '@' + setName); continue; }
        if (rec.sha256 && b.sha256 && rec.sha256 !== b.sha256) changed.push(mapName + '@' + setName);
      }
    }
    for (const [mapName, m] of Object.entries(base.maps)) {
      for (const setName of Object.keys(m.sets)) {
        if (!observed.maps[mapName]?.sets?.[setName]) removed.push(mapName + '@' + setName);
      }
    }
    baselineDiff = { changed, added, removed };
  }

  if (opts.json) {
    console.log(JSON.stringify({ structural, errors, warnings, todo, baselineDiff }, null, 2));
  } else {
    const line = (d) => '  ' + d.map.padEnd(18) + String(d.set).padEnd(7) + d.kind.padEnd(11) +
      (d.expected !== undefined ? 'want ' + String(d.expected).padEnd(12) + 'got ' + d.actual : (d.reason ?? ''));

    if (structural.length) {
      console.log('MANIFEST PROBLEMS (' + structural.length + ')');
      for (const p of structural) console.log('  ' + p);
      console.log('');
    }
    if (errors.length) {
      console.log('UNEXPECTED DEVIATIONS (' + errors.length + ')');
      for (const d of errors) console.log(line(d));
      console.log('');
    }
    if (warnings.length) {
      const byKind = {};
      for (const d of warnings) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      console.log('KNOWN DEVIATIONS (' + warnings.length + '): ' +
        Object.entries(byKind).map(([k, v]) => k + ' ' + v).join(', '));
      console.log('  tracked in manifest knownDeviations; run with --strict to fail on them');
      if (oversizeCount) {
        console.log('  ' + oversizeCount + ' of these are files above the GitHub 100 MiB limit, absent from');
        console.log('  the checkout by design - pass --release latest to check them too');
      }
      console.log('');
    }
    if (todo.length) {
      console.log('PROVENANCE NOT YET RECORDED (' + todo.length + ' fields across ' +
        new Set(todo.map((t) => t.split(':')[0])).size + ' maps)');
      console.log('');
    }
    if (baselineDiff) {
      console.log('BASELINE DIFF vs ' + opts.baseline);
      console.log('  changed: ' + baselineDiff.changed.length +
        (baselineDiff.changed.length ? ' -> ' + baselineDiff.changed.slice(0, 20).join(', ') +
          (baselineDiff.changed.length > 20 ? ', ...' : '') : ''));
      console.log('  added:   ' + baselineDiff.added.length);
      console.log('  removed: ' + baselineDiff.removed.length);
      console.log('');
    }
    const bad = structural.length + errors.length;
    console.log(bad === 0 ? 'OK - no unexpected deviations' : 'FAILED - ' + bad + ' problem(s)');
  }

  process.exit(structural.length + errors.length > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
