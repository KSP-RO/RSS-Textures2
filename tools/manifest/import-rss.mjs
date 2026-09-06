#!/usr/bin/env node
// Read heightmap parameters out of the RSS Kopernicus configs.
//
//   node tools/manifest/import-rss.mjs --rss ../KSP-RSS
//   node tools/manifest/import-rss.mjs --rss ../KSP-RSS --write
//
//   --rss <dir>       checkout of KSP-RO/RealSolarSystem
//   --manifest <file> default manifest/textures.json
//   --write           update the manifest in place (otherwise just report)
//
// Why this exists: TopoConv's heightscale and heightoffs at conversion time
// determine the offset and deformity a Kopernicus config must use. That
// coupling crosses a repository boundary, so regenerating a heightmap with
// different parameters silently breaks terrain in RSS rather than here.
// Copying the values in makes the dependency checkable.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HEIGHT_NODES = ['VertexHeightMap', 'VertexHeightMapRSS'];

// Fields we care about inside a height node.
const FIELD = /^\s*(?:[@%!+\-*]*)(map|offset|deformity|scaleDeformityByRadius|order|enabled)\s*=\s*(.+?)\s*$/i;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.toLowerCase().endsWith('.cfg')) yield full;
  }
}

/**
 * Pull height-map nodes out of a Kopernicus config.
 *
 * Kopernicus configs are brace-delimited with optional ModuleManager prefixes
 * (@, %, +, -). We do not need a full parser: find a line naming a height node,
 * then read forward to its matching close brace, collecting scalar fields.
 * Comments are // to end of line.
 */
export function extractHeightNodes(text, sourcePath) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ''));
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^\s*(?:[@%!+\-*]*)([A-Za-z_]\w*)\s*(\{)?\s*$/);
    if (!name || !HEIGHT_NODES.includes(name[1])) continue;

    // The opening brace is either on this line or the next non-blank one.
    let j = i;
    if (!name[2]) {
      while (j + 1 < lines.length && lines[j + 1].trim() === '') j++;
      if (!lines[j + 1] || !lines[j + 1].includes('{')) continue;
      j++;
    }

    let depth = 0;
    const node = { node: name[1], source: sourcePath, line: i + 1 };
    for (; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      const f = lines[j].match(FIELD);
      if (f && depth >= 1) node[f[1].toLowerCase()] = f[2];
      if (depth === 0 && j > i) break;
    }
    if (node.map) nodes.push(node);
    i = j;
  }
  return nodes;
}

function num(v) {
  if (v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function mapBasename(mapValue) {
  const file = String(mapValue).trim().split(/[\\/]/).pop();
  return file.replace(/\.dds$/i, '');
}

async function main() {
  const args = process.argv.slice(2);
  let rss = null, manifestPath = 'manifest/textures.json', write = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rss') rss = args[++i];
    else if (args[i] === '--manifest') manifestPath = args[++i];
    else if (args[i] === '--write') write = true;
    else throw new Error('unknown option: ' + args[i]);
  }
  if (!rss) throw new Error('need --rss <path to RealSolarSystem checkout>');

  const found = new Map(); // map basename -> [node, ...]
  let files = 0;
  for await (const cfg of walk(join(rss, 'GameData'))) {
    files++;
    const nodes = extractHeightNodes(await readFile(cfg, 'utf8'), cfg.slice(rss.length + 1).replace(/\\/g, '/'));
    for (const n of nodes) {
      const key = mapBasename(n.map);
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(n);
    }
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const applied = [], conflicts = [], unmatched = [], noConfig = [];

  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    const map = body.maps.Height;
    if (!map) continue;
    const key = bodyName + 'Height';
    const nodes = found.get(key);
    if (!nodes) { noConfig.push(key); continue; }

    const distinct = new Map();
    for (const n of nodes) {
      const sig = num(n.offset) + '/' + num(n.deformity) + '/' + (n.scaledeformitybyradius ?? '');
      if (!distinct.has(sig)) distinct.set(sig, []);
      distinct.get(sig).push(n);
    }
    if (distinct.size > 1) {
      conflicts.push({
        map: key,
        variants: [...distinct.entries()].map(([sig, ns]) => ({
          values: sig, sources: ns.map((n) => n.source + ':' + n.line),
        })),
      });
      continue;
    }
    const n = nodes[0];
    const rec = {
      offset: num(n.offset),
      deformity: num(n.deformity),
      node: n.node,
      source: n.source + ':' + n.line,
    };
    if (n.scaledeformitybyradius !== undefined) {
      rec.scaleDeformityByRadius = /true/i.test(n.scaledeformitybyradius);
    }
    map.rss = rec;
    map.todo = (map.todo ?? []).filter((t) => !t.startsWith('rss.'));
    applied.push({ map: key, offset: rec.offset, deformity: rec.deformity, node: rec.node });
  }

  for (const key of found.keys()) {
    const body = key.replace(/Height$/, '');
    if (!manifest.bodies[body]?.maps?.Height) unmatched.push(key);
  }

  console.log('scanned ' + files + ' cfg files, found ' + found.size + ' distinct height maps referenced\n');
  console.log('RESOLVED (' + applied.length + ')');
  for (const a of applied) {
    console.log('  ' + a.map.padEnd(16) + 'offset ' + String(a.offset).padStart(8) +
      '   deformity ' + String(a.deformity).padStart(10) + '   ' + a.node);
  }
  if (conflicts.length) {
    console.log('\nCONFLICTING VALUES (' + conflicts.length + ') - not written, needs a human');
    for (const c of conflicts) {
      console.log('  ' + c.map);
      for (const v of c.variants) console.log('    ' + v.values + '  <- ' + v.sources.join(', '));
    }
  }
  if (noConfig.length) console.log('\nNO KOPERNICUS HEIGHT NODE (' + noConfig.length + '): ' + noConfig.join(', '));
  if (unmatched.length) console.log('\nREFERENCED BY RSS BUT NOT IN MANIFEST (' + unmatched.length + '): ' + unmatched.join(', '));

  if (write) {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log('\nupdated ' + manifestPath);
  } else {
    console.log('\n(dry run - pass --write to update the manifest)');
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
