# Texture manifest

`manifest/textures.json` is the declared intent for every texture in the pack:
what resolution it exists at, what format it should be encoded in, whether it
carries mipmaps, where it installs, and where it came from.

Nothing generates textures from it yet. Its job right now is to make the
current state legible and to give a build pipeline something to be checked
against, so that when the encoder changes we can prove what changed and what
didn't.

## Why JSON and not YAML

Every top-level key in `sets` is a number (`"4096"`, `"16384"`). YAML would
parse those as integers in some loaders and strings in others, and `mips: none`
is a string here but `no` would be boolean. JSON has no such ambiguity, needs
no dependency on any runtime, and `jq` works on it. The cost is no comments,
so explanatory text lives in `note` fields and in this file.

## Running the tools

All of these are dependency-free Node scripts. Node 20+ is preinstalled on GitHub
Actions runners, so CI needs no setup step.

```sh
# What is actually on disk, as a table
node tools/manifest/scan.mjs

# ...including the 17 files too large for git, recovered from the release zip
# by reading its central directory over HTTP range requests (~500 KB, not 2 GB)
node tools/manifest/scan.mjs --release latest --alpha --nrm

# Import heightmap offset/deformity from a RealSolarSystem checkout
node tools/manifest/import-rss.mjs --rss ../KSP-RSS --write

# Check a tree against the manifest
node tools/manifest/verify.mjs --root .

# Check a rebuilt tree and report every file whose bytes changed
node tools/manifest/scan.mjs --root build/GameData --hash --out build/new.json
node tools/manifest/verify.mjs --observed build/new.json --baseline manifest/baseline.json
```

`verify.mjs` exits non-zero when it finds anything unexpected, so it drops
straight into a workflow step.

### Scan options

| Option | Effect |
| --- | --- |
| `--release <tag>` | Recover release-only 16k files from that release's `16384.zip`. Use `latest`. |
| `--alpha` | Read every DXT5 base mip and record whether the alpha channel is uniformly opaque. |
| `--nrm` | Fingerprint the DXT5nm RGB filler convention per normal map. |
| `--hash` | Record sha256 per file, for byte-exact rebuild comparisons. |
| `--sets <list>` | Comma-separated set override, e.g. `--sets 4096,8192`. |

A full `--alpha --nrm --hash` scan of the working tree takes about 20 seconds.

## Schema

### `sets`

The resolution sets that get packaged: **4096, 8192, 16384**. `cap` is the
maximum dimension a texture may take in that set.

2048 was dropped as unsupported. The set list lives in `tools/manifest/lib/sets.mjs`
and every tool takes `--sets 2048,4096` to inspect a historical tree. The
`2048/` directory and the `RSSTextures2048` CKAN module still exist; retiring
those is a separate decision, and note the netkan krefs match release assets by
unanchored substring, so any future asset whose name contains "2048" would keep
the obsolete module resolving.

### `groups`

Release packaging groups, one per planetary system. `16384.zip` is currently
1.94 GB against GitHub's 2 GiB per-asset limit, so future releases have to be
split; these are the intended split boundaries. Largest group today is Earth +
Moon at roughly 655 MiB compressed, which leaves substantial headroom.

### `shared`

Textures that belong to no body and are packaged into **every** asset, the way
`README.txt` is.

```json
"shared": {
  "Flat_NRM": { "native": [64, 32], "format": "DXT5", "mips": "full", "install": "PluginData" }
}
```

`Flat_NRM` is a 64x32 placeholder normal map, identical in all three sets,
that ten RSS configs point at where a body has no real one — Dione, Enceladus,
Iapetus, Mimas, Neptune, Rhea, Saturn, Tethys, Triton and Uranus.

It was originally modelled as a body called `Flat` in a packaging group called
`Shared`, because `bootstrap.mjs` derives bodies from filenames and
`Flat_NRM` splits into body `Flat` + kind `_NRM`. Two symptoms followed:

- every count of bodies needed a hardcoded `&& b !== 'Flat'`, in the preflight
  and again in `add-sources`
- a per-group split emitted an `RSS-Textures-<set>-Shared.zip` holding one
  2896-byte file, and the texture reached users only if they happened to
  install that group

Both are gone. `verify.mjs` rejects a manifest that declares the same texture
as both shared and a body map, and `bootstrap.mjs` recognises the name rather
than inventing a body for it.

### `kinds`

Defaults per map kind, keyed by filename suffix (`Color`, `Height`, `Biomes`,
`_NRM`, `Surface`, `Ring`). Each declares the install directory, mip policy,
colourspace, and the set of formats a map of that kind is allowed to use.
`verify.mjs` rejects a manifest that gives a map a format its kind disallows.

The constraints encoded here are load-bearing, not stylistic:

- **Biomes** are looked up as exact RGB values against biome definitions. Any
  lossy compression or mip level produces wrong biomes and broken science.
  They are `A8B8G8R8` — note the byte order, which is *not* the more common
  `A8R8G8B8`; swapping it silently permutes every biome.
- **Height** is never block-compressed. Five outer-moon heightmaps currently
  violate this (see `knownDeviations`), storing elevation in DXT colour
  channels at 5/6/5-bit endpoint precision.
- **`_NRM`** is DXT5nm: x in alpha, y in green. Unity's `UnpackNormal` ignores
  red and blue entirely. Any pipeline that treats these as ordinary RGB
  textures destroys them.

### `bodies.<Body>.maps.<Kind>`

| Field | Meaning |
| --- | --- |
| `native` | `[width, height]` of the highest-resolution version that exists. Every set target is `min(native, set.cap)`, preserving the 2:1 aspect. |
| `format` | Intended encoding. Must be listed in the kind's `formats`. |
| `mips` | `full` or `none`. |
| `install` | Present only when it differs from the kind default. `"."` means the mod root rather than `PluginData` — the always-loaded home-system textures. |
| `source` | Identifier of the source asset in the sources repo. `null` until re-sourced. |
| `derivedFrom` | The map on the same body this one was generated from, for assets with no independent primary source. |
| `generation` | Bumped when a derived asset is deliberately regenerated. |
| `rss` | Heightmaps only: the `offset` and `deformity` the RSS Kopernicus configs assume. |
| `todo` | Fields not yet filled in. |

#### On `derivedFrom`

For many bodies there is no primary source: the colour map came first, the
normal map was generated from it, and the heightmap from the normal map. That
chain is currently undocumented and lives in whoever's image editor produced
it. Recording it here has two payoffs — changing a colour map tells you exactly
which downstream art is now stale, and a regeneration becomes reproducible.

`generation` exists because regenerating a heightmap moves terrain under
landed craft and bases. That has to be a deliberate, release-noted act
coordinated with RSS, not a side effect of a colour tweak.

#### On `rss`

`tools/TopoConv/README.txt` documents that the `heightscale` and `heightoffs`
used at conversion time determine the `offset` and `deformity` values in RSS's
Kopernicus configs. That coupling crosses a repository boundary: regenerate a
heightmap with different parameters and terrain breaks in RSS, not here.

These values are imported from a RealSolarSystem checkout by `import-rss.mjs`,
which parses every `VertexHeightMap` / `VertexHeightMapRSS` node it can find
and matches them to manifest entries by map filename. All 21 heightmaps resolve
with no conflicting definitions. Re-run it after RSS changes a config:

```sh
node tools/manifest/import-rss.mjs --rss ../KSP-RSS          # report only
node tools/manifest/import-rss.mjs --rss ../KSP-RSS --write  # update manifest
```

Each imported entry records the `node` type and the `file:line` it came from,
so a disagreement can be traced without re-grepping the RSS tree. If a map is
defined more than once with different values the importer refuses to guess and
prints every variant with its source.

#### Maps the sources have and the pack does not

Source releases run ahead of the pack. `RSS-Textures-Source` v0.0.1 carries
heightmaps and normal maps for four Saturnian moons that currently point at
`Flat_NRM.dds` and have no `VertexHeightMap` node at all, plus two bodies
(Eris, Hyperion) that RSS has no config for.

Everything the sources can produce is packaged. There used to be a
`"status": "pending"` field that held such maps back — declared, buildable, and
deliberately left out of the release. It was the wrong default twice over: the
build converted those maps into the overlay and then discarded them, and a map
nobody ships is a map nobody tests.

What remains is the ordinary record. A declared map absent from the checkout is
a `missing` entry in `knownDeviations`, the same as any other gap, so
`verify.mjs --root .` stays green and the list is explicit. Delete the entry
once the map ships.

```sh
node tools/manifest/add-sources.mjs                   # report, latest release
node tools/manifest/add-sources.mjs --write           # add entries
node tools/manifest/add-sources.mjs --sources v0.0.1  # pin an older release
```

It reads each source archive's central directory over a range request first,
so it only downloads bodies that actually carry something new, and derives
`native` and `format` from the PNG rather than from a guess. Bodies the
manifest does not know need a packaging group (`--group Eris=Pluto`).

#### On `topoconv`

The TopoConv invocation that produced each heightmap. `null` everywhere, and
the one remaining piece of heightmap provenance that is not recoverable from
either repository. It matters because TopoConv owns the things that go visibly
wrong at the edges of an equirectangular map: `-fixpoles` for polar
discontinuities, `-inmeridian`/`-outmeridian` for longitude rotation, and the
resampler choice (`-median`, `-bilinear`, `-nearest`). PR #51 regenerated the
heightmaps using it; PR #53 fixed a median-filter bug that left black lines in
the output.

### `knownDeviations`

Every place the shipped files disagree with the intent above, recorded at
bootstrap time. `verify.mjs` reports these as warnings and unlisted deviations
as errors, so the tool starts green and the backlog is explicit instead of
invisible. `--strict` treats them as failures.

Delete an entry as you fix the underlying file. If `verify.mjs` then passes,
the fix worked.

## The current backlog

171 deviations, from the v18.6.1 release plus the working tree:

| Count | Kind | What it is |
| --- | --- | --- |
| 66 | missing | Declared from a source asset and produced by the build, but no DDS for it has ever shipped, so a checkout has none. 22 maps across three sets — heightmaps and normal maps for the outer moons, plus Eris and Hyperion. `add-sources.mjs` writes these as it declares each map, and they clear themselves as the maps ship. |
| 48 | format | DXT5 textures whose alpha channel is uniformly opaque. DXT1 carries the same colour data at half the size. In the 16k set alone this is ~103 MiB against a 200 MiB headroom. |
| 18 | mips | Missing mip chains, all in the 16384 set, including eight of the largest textures. Causes shimmering at distance. |
| 17 | missing | Textures above GitHub's 100 MiB limit, present only in the release zip. |
| 13 | format | Format differs between sets for the same map — the 16384 set uses DXT5 where 4096 and 8192 use DXT1. Two build eras, two tools. |
| 8 | size | A set ships a resolution that isn't `min(native, cap)`: `NeptuneColor` is 2048 in both the 4096 and 8192 packs when 16k exists, and `MercuryColor`, `Mercury_NRM`, `TritonColor`, `VenusColor`, `Venus_NRM` are all 4096 in the 8192 pack. |
| 1 | missing | `EarthHeight` is absent from the 8192 set. It exists at 16k in the release and at 4096 in the smaller set, so only the 8192 slot is unaccounted for — `scan.mjs` only consults `16384.zip`, so confirm against `8192.zip` before treating this as real. |

Six of those 17 oversize files would fit in git under their intended format:
`MarsColor`, `MercuryColor`, `SaturnColor`, `TritonColor`, `UranusColor` and
`VenusColor` ship as 128 MiB mipless DXT5, where DXT1 with a full mip chain is
85.3 MiB. Fixing the format bug would also put them back in the repository.


## What isn't here yet

- **A builder.** Nothing reads the manifest and produces DDS. That needs an
  encoder decision (nvtt, DirectXTex, Compressonator, ISPC), and every choice
  produces byte-different output from the current nvdxt-era files.
- **Provenance.** 131 fields across 110 maps are `null`. Only the maintainers
  know these.
- **TopoConv invocations.** Every heightmap has a `topoconv: null` slot.
  TopoConv already owns longitude wrap and polar discontinuities (`-fixpoles`,
  `-inmeridian`/`-outmeridian`, resampler choice), and #51 regenerated the
  heightmaps with it while #53 fixed a median-filter bug that produced black
  lines. Those flags determine the terrain, and so determine the `rss` values
  sitting next to them, but they are not recorded anywhere.
