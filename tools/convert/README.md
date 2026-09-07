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

Downscaling instead would move terrain by tens of metres and put landed craft
underground. `--allow-height-downscale` overrides it for experiments.

This is what the manifest's `topoconv` field is for. Heights are *generated per
set* by TopoConv from the DEM, not derived from each other, and the invocation
belongs next to the `rss` offset/deformity values it determines.

## Sources

```sh
node tools/convert/convert.mjs --preflight --sources v0.0.1
node tools/convert/convert.mjs --set 4096 --sources v0.0.1 --out build/4096
```

Bodies are fetched on demand and cached by asset id and size, so a rebuild
downloads nothing. Only the bodies a run needs are pulled — the full set is
2.5 GiB compressed, 5.7 GiB of PNG.

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
