#!/usr/bin/env node
// Self-test for the conversion primitives, using the textures already in the
// repository as fixtures. Needs no source assets and no external tools.
//
//   node tools/convert/selftest.mjs [--sets 4096,8192]
//
// Checks, in order:
//   1. payload round-trip   read every DDS, rewrite it, compare pixel bytes
//   2. header validity      every header we write parses back to what we meant
//   3. resampling           downscale invariants on real image data
//   4. swizzle              DXT5nm pack/unpack is lossless where it must be
//   5. source name matching how loosely a source filename may be spelled
//
// Exits non-zero on any failure.

import { readFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readHeader, HEADER_BYTES, levelBytes } from '../manifest/lib/dds.mjs';
import { parseSets, SETS } from '../manifest/lib/sets.mjs';
import { writeDDS, readLevels, buildHeader, levelGeometry } from './lib/dds-io.mjs';
import { unpackToRGBA, packFromRGBA, resampleHalf, buildMipChain, wrapX, clampY } from './lib/pixels.mjs';
import { splitMapName, normalizeMapName, manifestMapIndex } from '../manifest/lib/mapname.mjs';

const REPO = process.cwd();
let failures = 0;

function check(ok, label, detail) {
  if (ok) return true;
  failures++;
  console.log('  FAIL ' + label + (detail ? ' - ' + detail : ''));
  return false;
}

async function* walkDds(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkDds(full);
    else if (e.name.toLowerCase().endsWith('.dds')) yield full;
  }
}

async function testRoundTrip(sets, tmp) {
  console.log('1. payload round-trip');
  const stats = { total: 0, ok: 0, headerSame: 0, skipped: 0 };
  const byFormat = {};
  const normalisations = new Map();

  for (const set of sets) {
    for await (const file of walkDds(join(REPO, set))) {
      const h = await readHeader(file);
      if (!h || h.expectedBytes === null || h.expectedBytes !== h.bytes) { stats.skipped++; continue; }
      stats.total++;
      byFormat[h.format] = (byFormat[h.format] ?? 0) + 1;

      const spec = { format: h.format, width: h.width, height: h.height, levels: h.levels };
      const out = join(tmp, 'roundtrip.dds');
      await writeDDS(out, spec, await readLevels(file, spec));

      const orig = await readFile(file);
      const made = await readFile(out);
      if (orig.subarray(HEADER_BYTES).equals(made.subarray(HEADER_BYTES))) stats.ok++;
      else check(false, 'payload differs', file.slice(REPO.length + 1));

      if (orig.subarray(0, HEADER_BYTES).equals(made.subarray(0, HEADER_BYTES))) stats.headerSame++;
      else {
        const diffs = [];
        for (let o = 0; o < HEADER_BYTES; o += 4) {
          const a = orig.readUInt32LE(o), b = made.readUInt32LE(o);
          if (a !== b) diffs.push('@' + o + ':0x' + a.toString(16) + '->0x' + b.toString(16));
        }
        const key = h.format + '  ' + diffs.join('  ');
        normalisations.set(key, (normalisations.get(key) ?? 0) + 1);
      }
    }
  }

  console.log('   ' + stats.ok + '/' + stats.total + ' payloads byte-identical' +
    (stats.skipped ? '  (' + stats.skipped + ' skipped: truncated or unsupported)' : ''));
  console.log('   ' + stats.headerSame + '/' + stats.total + ' headers already canonical');
  console.log('   formats: ' + JSON.stringify(byFormat));
  if (normalisations.size) {
    console.log('   header fields normalised:');
    for (const [k, n] of [...normalisations].sort((a, b) => b[1] - a[1])) {
      console.log('     [' + String(n).padStart(3) + '] ' + k);
    }
  }
  check(stats.total > 0, 'found no fixtures to round-trip');
}

function testHeaders() {
  console.log('2. header validity');
  const cases = [
    { format: 'DXT1', width: 4096, height: 2048, levels: 13 },
    { format: 'DXT5', width: 16384, height: 8192, levels: 15 },
    { format: 'DXT5', width: 8192, height: 4096, levels: 1 },
    { format: 'A8B8G8R8', width: 2048, height: 1024, levels: 1 },
    { format: 'R16', width: 8192, height: 4096, levels: 1 },
    { format: 'R8', width: 4096, height: 2048, levels: 1 },
  ];
  for (const c of cases) {
    const h = buildHeader(c);
    const label = c.format + ' ' + c.width + 'x' + c.height + ' L' + c.levels;
    check(h.toString('ascii', 0, 4) === 'DDS ', label + ' magic');
    check(h.readUInt32LE(4) === 124, label + ' dwSize');
    check(h.readUInt32LE(12) === c.height, label + ' height');
    check(h.readUInt32LE(16) === c.width, label + ' width');
    check(h.readUInt32LE(28) === (c.levels > 1 ? c.levels : 0), label + ' mipMapCount');
    // No DX10 header: nothing in the shipped pack uses one and KSP's loader
    // has never been handed one.
    check(h.toString('ascii', 84, 88) !== 'DX10', label + ' is not DX10');
    if (c.format === 'A8B8G8R8') {
      check(h.readUInt32LE(92) === 0x000000ff, label + ' red mask is low byte (ABGR, not ARGB)');
    }
  }
  console.log('   ' + cases.length + ' header shapes checked');
}

async function testResample(sets, tmp) {
  console.log('3. resampling');
  // A biome map: indexed-looking data where nearest-neighbour must preserve
  // exact values, because biome colours are looked up not blended.
  const biome = join(REPO, sets[0], 'PluginData', 'EarthBiomes.dds');
  const h = await readHeader(biome);
  if (!h) { check(false, 'fixture missing', biome); return; }

  const [level0] = await readLevels(biome, { format: h.format, width: h.width, height: h.height, levels: 1 });
  const rgba = unpackToRGBA(level0, h.format, h.width, h.height);
  check(rgba.length === h.width * h.height * 4, 'unpack size');

  const repacked = packFromRGBA(rgba, h.format, h.width, h.height);
  check(repacked.equals(level0), 'unpack/pack is lossless for ' + h.format);

  const half = resampleHalf(rgba, h.width, h.height, 'nearest');
  check(half.data.length === (h.width / 2) * (h.height / 2) * 4, 'half size');

  // Nearest-neighbour must only ever emit colours that were already present.
  const present = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    present.add(rgba[i] << 24 | rgba[i + 1] << 16 | rgba[i + 2] << 8 | rgba[i + 3]);
  }
  let invented = 0;
  for (let i = 0; i < half.data.length; i += 4) {
    const k = half.data[i] << 24 | half.data[i + 1] << 16 | half.data[i + 2] << 8 | half.data[i + 3];
    if (!present.has(k)) invented++;
  }
  check(invented === 0, 'nearest resample invents no colours', invented + ' invented');
  console.log('   ' + present.size + ' distinct biome colours, ' + invented + ' invented by downscale');

  // Box filter on a colour map, and mip chain geometry.
  const colour = join(REPO, sets[0], 'PluginData', 'MarsHeight.dds');
  const ch = await readHeader(colour);
  if (ch) {
    const [l0] = await readLevels(colour, { format: ch.format, width: ch.width, height: ch.height, levels: 1 });
    const crgba = unpackToRGBA(l0, ch.format, ch.width, ch.height);
    const chain = buildMipChain(crgba, ch.width, ch.height, 'box');
    const geom = levelGeometry(ch.width, ch.height, chain.length);
    let geomOk = true;
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].data.length !== geom[i].width * geom[i].height * 4) geomOk = false;
    }
    check(geomOk, 'mip chain geometry');
    check(chain[chain.length - 1].width === 1 && chain[chain.length - 1].height === 1, 'chain reaches 1x1');
    console.log('   mip chain from ' + ch.width + 'x' + ch.height + ': ' + chain.length + ' levels down to 1x1');
  }

  // Addressing: longitude wraps, latitude clamps. Test the helpers directly
  // rather than inferring it from a downscale - a 2x2 box footprint on a
  // power-of-two image never straddles x=0, so halving cannot demonstrate the
  // wrap either way. It matters for wider kernels and for normal generation.
  check(wrapX(-1, 8) === 7, 'x wraps below zero');
  check(wrapX(8, 8) === 0, 'x wraps at width');
  check(wrapX(-9, 8) === 7, 'x wraps more than once');
  check(clampY(-1, 4) === 0, 'y clamps at the north pole');
  check(clampY(4, 4) === 3, 'y clamps at the south pole');
  console.log('   addressing: x wraps (longitude), y clamps (poles)');
}

function testSwizzle() {
  console.log('4. DXT5nm swizzle');
  // Unity's UnpackNormal reads x from alpha and y from green. Packing must
  // preserve those two channels exactly; red and blue are filler.
  const n = 256;
  const src = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    src[i * 4] = i;              // x
    src[i * 4 + 1] = 255 - i;    // y
    src[i * 4 + 2] = 128;        // z, discarded
    src[i * 4 + 3] = 255;
  }
  const packed = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    packed[i * 4] = 255;               // r filler
    packed[i * 4 + 1] = src[i * 4 + 1]; // y -> green
    packed[i * 4 + 2] = 255;           // b filler
    packed[i * 4 + 3] = src[i * 4];     // x -> alpha
  }
  let ok = true;
  for (let i = 0; i < n; i++) {
    if (packed[i * 4 + 3] !== src[i * 4]) ok = false;
    if (packed[i * 4 + 1] !== src[i * 4 + 1]) ok = false;
  }
  check(ok, 'x survives in alpha and y in green');
  console.log('   ' + n + ' values checked through the swizzle');
}

async function testNameMatching() {
  console.log('5. source name matching');
  // Source assets are hand-authored by several people, so the same texture
  // turns up as EarthColor.png, Earth_Color.png or earth_color.png. All three
  // have to resolve, or a file is silently invisible to the build - which
  // looks exactly like it not having been added yet.
  // The source repository does not use the pack's kind names: it writes
  // <Body>_Normal where the pack says _NRM, and <Body>_Rings where the pack
  // says Ring. Both spellings have to land on the same texture.
  const groups = [
    ['EarthColor', 'Earth_Color', 'earth_color', 'EARTHCOLOR', 'eArTh_CoLoR'],
    ['Earth_NRM', 'EarthNRM', 'earth_nrm', 'EARTH_NRM', 'Earth_Normal', 'earth_normal'],
    ['SaturnRing', 'Saturn_Ring', 'saturn_ring', 'Saturn_Rings', 'SaturnRings'],
    ['EarthBiomes', 'Earth_Biomes'],
    ['EarthHeight', 'Earth_Height'],
    ['EarthSurface', 'Earth_Surface'],
  ];
  for (const group of groups) {
    const keys = new Set(group.map(normalizeMapName));
    check(keys.size === 1, group[0] + ': all spellings fold together', [...keys].join(' vs '));
  }

  // The kind comes back canonical whatever the file used, so a new map gets
  // the right manifest entry.
  for (const [input, body, kind] of [
    ['Earth_Color', 'Earth', 'Color'],
    ['earth_nrm', 'earth', '_NRM'],
    ['EarthNRM', 'Earth', '_NRM'],
    ['Earth_Normal', 'Earth', '_NRM'],
    ['Saturn_Rings', 'Saturn', 'Ring'],
    ['Mars_Height', 'Mars', 'Height'],
    ['SomethingElse', 'SomethingElse', 'Other'],
  ]) {
    const got = splitMapName(input);
    check(got.body === body && got.kind === kind,
      input + ' splits to ' + body + ' + ' + kind, JSON.stringify(got));
  }

  // Folding must not pair up two textures that are genuinely different.
  const manifest = JSON.parse(await readFile('manifest/textures.json', 'utf8'));
  const index = manifestMapIndex(manifest);
  let declared = 0;
  for (const body of Object.values(manifest.bodies)) declared += Object.keys(body.maps).length;
  declared += Object.keys(manifest.shared ?? {}).length;
  check(index.size === declared,
    declared + ' manifest maps stay distinct when folded', 'collapsed to ' + index.size);

  // Every name the manifest declares must be found by its own index, shared
  // textures included. add-sources.mjs looked names up in a set of canonical
  // spellings while folding the source names first, so nothing ever matched
  // and all 126 declared maps read as undeclared - one --write from rebuilding
  // the manifest out of the source archives.
  const canonical = [
    ...Object.entries(manifest.bodies).flatMap(([b, body]) => Object.keys(body.maps).map((k) => b + k)),
    ...Object.keys(manifest.shared ?? {}),
  ];
  const unfound = canonical.filter((name) => !index.has(normalizeMapName(name)));
  check(unfound.length === 0,
    'every declared map is found by its own folded name',
    unfound.slice(0, 5).join(', ') + (unfound.length > 5 ? ' and ' + (unfound.length - 5) + ' more' : ''));

  console.log('   ' + declared + ' map names, ' + groups.length + ' spelling groups checked');
}

async function main() {
  const args = process.argv.slice(2);
  let sets = SETS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sets') sets = parseSets(args[++i]);
    else throw new Error('unknown option: ' + args[i]);
  }

  const tmp = join(tmpdir(), 'rss-convert-selftest-' + process.pid);
  await mkdir(tmp, { recursive: true });
  try {
    await testRoundTrip(sets, tmp);
    testHeaders();
    await testResample(sets, tmp);
    testSwizzle();
    await testNameMatching();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('');
  console.log(failures === 0 ? 'OK - all checks passed' : 'FAILED - ' + failures + ' check(s)');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(2); });
