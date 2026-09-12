# Texture conversion

Produces DDS from source assets, driven by `manifest/textures.json`.

Source assets come from
[KSP-RO/RSS-Textures-Source](https://github.com/KSP-RO/RSS-Textures-Source),
one zip per body on a release. `v0.0.1` carries 34 PNGs across 13 bodies —
a deliberately partial set, which the converter reports rather than trips over.

## Encoder choice

Compressonator **4.5.52, pinned**, without running the comparison. BSD-licensed, prebuilt binaries
for Windows/Linux/macOS, CPU-only so output does not drift with a GPU driver,
and it reads and writes plain DDS so no PNG encoder is needed anywhere. nvtt,
DirectXTex and ISPC were not benchmarked against it; that question is open and
`manifest/baseline.json` is what an A/B would measure against.

It is only needed for 57 of the 110 maps. The other 53 — every biome map and
every heightmap — are uncompressed, so they are a header plus raw bytes with no
encoder involved at all.

```sh
node tools/convert/convert.mjs --preflight
```

```
backends
  OK      raw             A8B8G8R8,A8R8G8B8,R8,R16  built in
  MISSING compressonator  DXT1,DXT5                 not found on PATH

maps by backend
    57  compressonator
    53  raw
```

Fetch it with the pinned version, on Linux or Windows:

```sh
node tools/convert/get-compressonator.mjs           # into tools/.bin
export COMPRESSONATOR="$(node tools/convert/get-compressonator.mjs --print)"
```

CI caches `tools/.bin` keyed on the version and runner OS, so it downloads
once. The version is pinned deliberately: a new Compressonator release can
change block selection and silently alter every colour map in the pack.
Bumping it belongs with a visual diff against `manifest/baseline.json`, not
with a routine build.

`COMPRESSONATOR` overrides the lookup if you installed it yourself.

## What the pipeline does, and why not in the encoder

Mip generation, gamma and the DXT5nm swizzle all happen before the encoder is
called, one level at a time. That is deliberate: encoders build mip chains with
a gamma-naive box filter and clamped edges, which is how you get planets that
darken at distance and a seam down the prime meridian. `encodeLevel()` takes one
level of RGBA and returns block bytes; nothing else is delegated.

Resampling is per kind, and the choices are not stylistic:

| Kind | Filter | Why |
| --- | --- | --- |
| `Biomes` | nearest | Colours are looked up against biome definitions. An averaged colour is a biome that does not exist. |
| `Height` | median | Matches TopoConv. A box filter flattens peaks. |
| everything else | box | |

Addressing wraps in x and clamps in y — longitude is continuous, the poles are
not adjacent. Worth being precise: this is **inert** for the 2×2 box halving,
because on a power-of-two image a 2×2 footprint never straddles x=0. It starts
mattering for wider kernels and for generating a normal map from height, where
the gradient at x=0 must see the far edge.

## Heightmaps are not downscaled

`convert.mjs` refuses to produce a heightmap by downscaling a larger one, and
this is the most important behaviour in the tool.

Halving the shipped 8192 `MoonHeight` and comparing against the shipped 4096:

```
MoonHeight  8192 -> 4096      (deformity 19905.8 m, 0.304 m/unit)
   box      identical 0.6%    mean 183.4 units (56 m)   max 3500 (1064 m)
   median   identical 0.7%    mean 182.9 units (56 m)   max 3539 (1075 m)
   nearest  identical 0.4%    mean 340.1 units          max 5053
   (neighbour-to-neighbour variation within the shipped 4096: mean 366.0 units)
```

No filter comes close. Box and median land at half the map's own local relief,
and nearest matches it outright — the signature of two independent resamplings
of the same terrain rather than one derived from the other. TopoConv resamples
the source DEM at each target width; that is what produced the shipped files.

This is what the manifest's `topoconv` field is for. Heights are *generated per
set* by TopoConv from the DEM, not derived from each other, and the invocation
belongs next to the `rss` offset/deformity values it determines.

### ...but only where a DEM exists

That measurement compares a downscale against a DEM resample, so it argues for
preferring the DEM — not against downscaling as such. Most heightmaps have no
DEM behind them at all: the PNG is the primary source, or the map was derived
from a normal map in someone's image editor. Refusing to downscale those means
the 4096 and 8192 packs ship no terrain for those bodies, which is strictly
worse than terrain resampled a little differently.

So `convert.mjs` downscales a heightmap from its source PNG — 16-bit
throughout, median-filtered, the same filter TopoConv uses — and defers to
`heights.mjs` only for maps that declare a `topoconv` spec, which would
otherwise be generated twice and overwritten. A downscaled heightmap says so in
its conversion report note.

The caution that motivated the old restriction still holds, and is handled
where it belongs: a regenerated heightmap moves terrain under landed craft, so
`heights.mjs --compare` reports drift against what already shipped, the build
raises it as a warning annotation, and the release still gets cut.

## Heightmaps from a DEM

DEMs ship on the source release alongside the texture zips, so a run fetches
them the same way `convert.mjs` fetches sources — same `--sources` tag, same
`.cache/sources`:

```sh
node tools/convert/heights.mjs --list
node tools/convert/heights.mjs --set 8192 --out overlay/8192
node tools/convert/heights.mjs --dem topo30=D:/topo30.raw --set 8192 --out overlay/8192
```

Which asset holds a DEM is the manifest's to say — `dems.<id>.asset`. They are
published raw rather than zipped: `topo30.raw` is 1.74 GiB, inside GitHub's
2 GiB per-asset limit, and a zip that size cannot be inflated in memory, so a
zipped DEM is refused with that explanation rather than half-supported.
`--dem <id>=<path>` still overrides with a local file, which is the fast way to
work offline.

Output drops straight into an overlay root, so it composes with the texture
converter:

```
=== set 4096 ===
  1 map(s) taken from the overlay, the rest from the checkout
    EarthHeight
```

**Widths come from what a set actually ships, not `min(native, cap)`.** The
4096 set carries `EarthHeight` at 8192×4096, which the manifest records in
`knownDeviations`. Generating at the rule's width would replace a shipped
texture with one of half the resolution, and nothing downstream would object:
`build.mjs` packages whatever the overlay contains without re-checking its
geometry.

This is also the one texture a release cannot carry from git. `EarthHeight` is
absent from the checkout for the 8192 and 16384 sets — 256 MiB at 16384
breaches GitHub's 100 MiB file limit — so those packs currently ship with no
Earth terrain at all. Generating from the DEM fills that in:

```
=== set 16384 ===                        before          after
  files absent from the checkout         17              16
  EarthHeight                            omitted         from the overlay
```

**`heightscale` and `heightoffs` are not parameters.** They are derived from
the manifest's `rss` values, because they are the same two numbers:

```
deformity = 65535 / heightscale     ->  heightscale = 65535 / deformity
offset    = -heightoffs             ->  heightoffs  = -offset
```

TopoConv's `-autoscale -autooffset` print exactly these, which is how the
shipped values were obtained originally. Deriving them means the DEM-to-16-bit
mapping is identical at every width and cannot drift from what RSS expects. If
those numbers disagree, terrain sits at the wrong altitude.

Each generated file's geometry and format are checked against the manifest;
a mismatch fails the run.

### topo30.raw is *nearly* the right DEM

Running `-autoscale -autooffset` on it reports `heightscale 3.3426 (use
deformity=19606)` and `heightoffs 10921` — exactly the values in RSS's
`Earth.cfg`. So this is the right data, in the right units, big-endian int16
at 43200×21600.

But it does not reproduce the shipped map:

| Region | Shipped mean | This DEM | Delta |
| --- | --- | --- | --- |
| 40°S–40°N | −2678 m | −2678 m | **0 m** |
| Greenland band (60–80°N) | −58 m | −1034 m | −976 m |
| Antarctica (>70°S) | +43 m | −2647 m | **−2690 m** |

Maxima are identical everywhere (2190 m, 4035 m, 7152 m), and between 62°S and
51°N the two are 98–99% identical texel for texel. The difference is confined
to the ice sheets: this DEM lacks the ice-surface fill the shipped map has.
Overall that is a mean of 286 m and a maximum of 7896 m.

Publishing it would drop Antarctic terrain by roughly 2.7 km.

**Drift is reported, not enforced.** `--compare <set>` measures the generated
map against the one that set ships, and anything past `--drift-warn` (default
1 m) is called out:

```
  EarthHeight     8192x4096   R16      6.5 s   range -10825.9 / 7891.91
      vs shipped: identical 87.34%   mean 286.4 m   max 7896 m
      TERRAIN MOVED: more than 1 m from the shipped heightmap on average.
      Anything landed on the old terrain will be above or below it.

1 heightmap(s) moved terrain:
  EarthHeight     mean 286.4 m, max 7896 m
```

The run still succeeds. An earlier version of this failed the build instead,
which was wrong: changing the source DEM is a deliberate act, sometimes going
out alongside a coordinated RealSolarSystem config release, and a build that
refuses to package moved terrain leaves no way to ship that change at all.
Releases are cut as pre-releases, so the judgement belongs to whoever reads the
warning rather than to the exit code.

`--report <file>` writes the same information as JSON, including a `drifted`
array, which is what the workflow turns into a warning annotation and a job
summary callout.

Only the 4096 set has a shipped `EarthHeight` to compare against, so the build
passes `--compare 4096` for every set. At 8192 the generated width matches it
and the comparison is real; at 16384 the geometry differs and it says so
instead:

```
      vs shipped: shipped is 8192x4096, generated is 16384x8192
```

### TopoConv builds on Linux

It was a Windows x64 console binary, and `tools/TopoConv/bin/TopoConv.exe` is
still committed because every heightmap in the pack came out of it. But the
source was never Windows-specific — no Windows API, no graphics, only MSVC
dialect and `<ddraw.h>` for `DWORD` and `DDPIXELFORMAT` — so it is a native
build rather than a Wine gamble:

```sh
make -C tools/TopoConv
```

`tools/convert/heights.mjs` picks `bin/TopoConv` or `bin/TopoConv.exe` by
platform. Portability is confined to `tools/TopoConv/compat.h`; the `.cpp`
files differ from the originals only in their includes, and one `strcat_s`
call with a wrong buffer-size argument that could not be shimmed faithfully.

**The port is only worth anything if it is bit-identical**, because the output
positions terrain. Measured on `EarthHeight` at 4096 from the real
43200×21600 `topo30.raw`, all three agree to the byte:

| Binary | Source | Toolchain | sha256 |
| --- | --- | --- | --- |
| committed `TopoConv.exe` | pre-port | MSVC v142 | `4f917285…` |
| rebuilt `TopoConv.exe` | ported | MSVC 14.51 | `4f917285…` |
| `TopoConv` | ported | GCC 15.2 | `4f917285…` |

Eight synthetic cases covering the other code paths — bilinear, nearest,
median with both odd and even window sizes, `ra8`/`r1` output, `coastdefine`,
`autoscale` — matched as well.

Identical is plausible rather than lucky: the resampling calls no
transcendental functions — only `ceil`, `floor` and `sqrt`, which IEEE 754
requires to be correctly rounded — and median is `nth_element`, a selection
rather than an arithmetic result. Every parallel loop writes its own output
row, so output does not depend on thread count either. The one real hazard is
FMA contraction, which GCC enables by default and MSVC does not; the Makefile
passes `-ffp-contract=off`, and dropping that flag is the one change most
likely to move terrain without touching a line of logic.

There is no automated parity check. If you edit the source or bump a
compiler, generate the same heightmap before and after and compare the bytes.

### Running it in CI

Part of the release build — `.github/workflows/build.yml`, one step per set,
after the conversion step and into the same overlay. There is no separate
heightmap workflow any more.

It sits after `convert.mjs` deliberately: if a source release ever adds an
`EarthHeight.png`, the converter would produce one, and the DEM-derived map is
the authoritative one, so it lands last and wins.

The two things that used to keep this out of the release build are both
answered rather than ignored:

- **The DEM is nowhere CI can reach.** No longer true — DEMs ship on the source
  release, so the shared `.cache/sources` entry covers them. That entry is
  7.78 GiB, which is worth watching against a hosted runner's ~14 GB of free
  disk and a 6 GB checkout, and against the 10 GB per-repository cache limit.
- **Regenerated terrain moves.** Still true, and now surfaced instead of
  deferred. The build compares against the shipped heightmap and, when they
  disagree, emits a `::warning::` annotation on the run and a callout in the
  job summary — then finishes and publishes. It does not fail: a DEM change is
  sometimes exactly the intent, and releases go out as pre-releases, so this is
  a decision for whoever reads the warning.

TopoConv is built from source (`make -C tools/TopoConv`) in both the gate job
and each build job. The gate job also runs `--list` and a `--dry-run` for every
set, which needs no DEM, so a broken heightmap path fails in seconds instead of
after three jobs have each pulled 1.74 GiB.

Only `EarthHeight` has a `topoconv` spec so far. The other 28 heightmaps have
no recorded invocation, so they cannot be regenerated from a DEM — `--list`
names them, and `convert.mjs` produces their set variants by downscaling the
source PNG.

## Sources

No source release is pinned anywhere: every tool defaults to the latest
release of `KSP-RO/RSS-Textures-Source`, and `--sources <tag>` pins an older
one when a build has to be reproduced.

```sh
node tools/convert/convert.mjs --preflight
node tools/convert/convert.mjs --set 4096 --out build/4096
node tools/convert/convert.mjs --print-tag            # which release that is
node tools/convert/convert.mjs --set 4096 --sources v0.0.1 --out build/4096
```

The workflow resolves the tag once, in the gate job, and passes it to all
three build jobs — so the sets in one release always come from the same source
release even if one is published mid-run, and so the download cache still has
an immutable key.

Bodies are fetched on demand and cached by asset id and size, so a rebuild
downloads nothing. Only the bodies a run needs are pulled — the full set is
2.5 GiB compressed, 5.7 GiB of PNG.

### Fetching once, for all three sets

```sh
node tools/convert/fetch-sources.mjs --dry-run   # what a build will pull
node tools/convert/fetch-sources.mjs             # pull it into .cache/sources
```

The three sets build as a matrix, one runner each, and every one of them wants
the same 34 body archives and the same DEM:

```
source release v0.0.1: 35 asset(s), 7.78 GiB
  dem  topo30      1779.8 MiB  topo30.raw
  body Venus       1089.0 MiB  Venus.zip
  body Earth        739.3 MiB  Earth.zip
  ...
```

Left to themselves that is **23 GiB per run to deliver 7.8 GiB of distinct
bytes**, and on a cold cache all three also race to write the same cache entry,
so two lose and warn. So a `sources` job runs between the gate and the matrix:
it fetches once and saves the cache, and the build jobs restore it without ever
writing it. A restore miss is a warning, not a failure — the converter fetches
whatever is absent, so the build is still correct, just slower.

Note that matrix jobs get a runner each, so this was never three copies on one
disk; the cost was bandwidth and time, and the risk was three sets built from
different bytes. Run the same tool locally before going offline and every
subsequent build is local.

### The release index is cached too

In v19.0.6 the 4096 set failed with a bare `GitHub API 403` while 8192 and
16384 finished. It had restored all 7.3 GB of sources seconds earlier: what it
could not do was ask `api.github.com` which asset id `Mars.zip` has.

Unauthenticated API access is 60 requests an hour **per source IP**, and
GitHub-hosted runners leave through shared NAT per Azure region — so the budget
is shared with every other runner in the region and can already be spent when a
job starts. Nothing about the pack's own usage was excessive; two calls per job.

Three things changed, in descending order of how much they matter:

1. **A warm cache makes no API calls at all.** `fetch-sources.mjs` writes the
   resolved release index next to the assets as
   `release-<repo>-<tag>.json`, and `listRelease` reads it when given an
   explicit tag. A build that has the bytes no longer phones home to find out
   what they are called. `latest` still asks every time — "whatever is newest"
   is a question, not something to remember.
2. **Requests are authenticated** when `GITHUB_TOKEN` or `GH_TOKEN` is set,
   which raises the limit to 1000/hour for the repository. The workflow sets it
   once at the top level. Any valid token grants API read access to public
   repositories, so the token minted for this repo can read the sources repo.
3. **Failures retry and explain themselves.** `retry-after` and
   `x-ratelimit-reset` are honoured when the wait is short; an exhausted limit
   with a distant reset fails immediately rather than burning its attempts on
   backoff that cannot help. The message now carries the API's own reason, when
   the limit resets, and whether the request was authenticated:

```
GitHub API 403 for .../releases/tags/v0.0.1: API rate limit exceeded for 20.55.x.x.
Rate limit exhausted, resets in ~40 min.
No GITHUB_TOKEN/GH_TOKEN in the environment, so this request was unauthenticated:
60/hour shared with every other runner on this IP.
```

The set being partial is a first-class case, not an error. A run reports:

- maps with no source asset yet (skipped)
- sources smaller than the set's target resolution (skipped, with both sizes)
- **source files the manifest has no entry for** — v0.0.1 carries
  `DioneHeight`, `Dione_NRM`, `EnceladusHeight`, `Enceladus_NRM`,
  `MimasHeight`, `Mimas_NRM`, `RheaHeight`, none of which exist in the
  pack today, plus two entire bodies (Eris, Hyperion). Those need manifest
  entries before they can be built.

### What the sources actually are

Checked against v0.0.1, and worth knowing because several assumptions could
have gone the other way:

| | Finding |
| --- | --- |
| Normal maps | **Standard tangent-space** (channel means ≈ 125,131,254), not pre-swizzled. The DXT5nm swizzle is applied by this pipeline, per mip level, after the chain is built. A source that is already swizzled is detected and rejected rather than swizzled twice. |
| Heightmaps | Mixed. `RheaHeight` is 16-bit greyscale; `MimasHeight` and `EuropaHeight` are 8-bit RGBA with only 94 and 64 distinct levels. 8-bit sources are flagged in the run. |
| Colour maps | Mostly 16-bit RGB, some 8-bit. |
| Biome maps | `HyperionBiomes` is 16-bit RGB with 1947 texels off the 8-bit grid. Truncating those shifts the colour, and a shifted biome colour matches no biome — so it is reported, never silently truncated. |

## Encoder output is checked, not assumed

`lib/bc.mjs` decodes BC1/BC3 back to RGBA so encoder output can be measured.
The pipeline never needs it to build anything; it exists so "it produced a
file" can become "it produced the right file", and it is half of any future
encoder A/B.

Measured on real conversions from v0.0.1 sources:

```
NeptuneColor  4096x2048  DXT1  13 levels     level 0  50.47 dB
                                             level 1  49.40 dB
                                             level 5  45.69 dB
EuropaColor   4096x2048  DXT5  13 levels     level 0  42.77 dB

Europa_NRM    4096x2048  DXT5
   PSNR on the channels Unity reads (G=y, A=x)   47.37 dB
   PSNR on the red/blue filler                   identical
   decoded means  r=255.0  g=127.4  b=255.0  a=127.0
   source  means  r=127.2  g=127.6  b=254.6   (x, y, z tangent space)
```

The normal map result is the one that matters: decoded **alpha tracks source
red** and **green tracks source green**, which is the swizzle working. A
block-assembly bug would show ~10 dB rather than 47.

## Verification

```sh
node tools/convert/selftest.mjs
```

Needs no source assets and no external tools; uses the repository's own
textures as fixtures.

1. **Payload round-trip** — every DDS is read, rewritten by our writer, and the
   pixel payload compared. **110/110 byte-identical.**
2. **Header validity** — six header shapes checked, including that we never
   emit a DX10 header and that `A8B8G8R8` keeps red in the low byte.
3. **Resampling** — nearest invents no biome colours (11 distinct colours in
   `EarthBiomes`, 0 invented); mip chains reach 1×1 with correct geometry;
   addressing wraps and clamps as intended.
4. **Swizzle** — x survives in alpha and y in green across all 256 values.

End to end, regenerating the uncompressed 4096 maps from the 8192 set:

```sh
node tools/convert/convert.mjs --set 4096 --from 8192 --kinds Biomes,Height --out build/4096
```

**44 built, all byte-identical to the shipped 4096 files.** 9 skipped, each
with a reason: 5 are the GIMP-exported DXT5 heightmaps (decoding and
re-encoding would compound loss), 3 are heightmaps that would need downscaling,
1 is absent from the 8192 set.

## Headers are normalised

Only 3 of 110 existing files carry a header this tool would write. The pack
uses three conventions from three eras. We emit one canonical form per the
Microsoft spec — `DDSD_PITCH` with bytes-per-row for uncompressed,
`DDSD_LINEARSIZE` with level-0 bytes for block compressed — which is already
what the DXT files and the R16 heightmaps do.

The normalisations are: `dwDepth` 1 → 0 (unused for 2D), `dwMipMapCount` 1 → 0
for unmipped surfaces, R8 files switching from `DDSD_LINEARSIZE` to the
spec-correct `DDSD_PITCH`, and clearing the writer signature stamped in
`dwReserved1`.

**Worth checking in game before shipping.** Most loaders ignore
`dwPitchOrLinearSize` and compute from dimensions, but the R8 change is the one
that would show up if KSP's loader does read it.

### A provenance find

That reserved-field signature identifies its writer. 18 files carry
`GIMP-DDS v3.0.1`:

```
Ariel, Miranda, Oberon, Titania, Umbriel  Height  (all three sets)
Ceres, Deimos, Phobos                     Color   (16384 only)
```

Those five heightmaps are exactly the ones storing elevation in DXT colour
channels at 5/6/5-bit endpoint precision. The cause is now known: they were
exported through GIMP's DDS plugin, which defaulted to DXT5, instead of going
through TopoConv. That is why those five moons have visibly quantised terrain.

## Where this stops

- **Gamma.** Colour mips are downsampled by averaging sRGB values directly,
  which is the common bug rather than the correct behaviour. Should be linear
  light. Not fixed because it changes every colour map and belongs with the
  encoder decision.
- **`source` fields are still `null`** in the manifest. The converter finds
  sources by name convention (`<Body><Kind>.png` inside
  `RSS-Textures-src-<Body>.zip`), which works, but the manifest should record
  it explicitly once the source layout settles.
- **Normal map generation.** `derivedFrom` records that many normals come from
  colour or height; nothing generates them.
- **Memory.** `VenusColor.png` is 769 MiB and decodes to a ~537 MB buffer.
  Fine on a 16 GB runner one at a time, but `--jobs 4` on the large bodies
  would not be. Not yet streamed.
