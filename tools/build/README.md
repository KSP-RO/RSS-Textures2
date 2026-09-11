# Release builder

Builds the release assets from `manifest/textures.json`. Replaces `bin/build.pl`
and the dead `.travis.yml`.

**This does not convert anything itself.** Without `--overlay` it packages the
DDS already in the checkout, byte-identical to what shipped last time and
carrying no visual risk. That is still the default, and it is what the release
workflow does.

## Bringing conversion into a release

```sh
node tools/convert/convert.mjs --set 4096 --sources latest --out build/4096
node tools/build/build.mjs --set 4096 --overlay build --out dist
```

`--overlay <root>` prefers files from a root laid out like the repository
(`4096/`, `8192/`, …) and falls back to the checkout for anything conversion
could not produce. The build prints which maps came from where.

The fallback is the point rather than a convenience: v0.0.1 of the source
repository covers 13 of 33 bodies, several incomplete, so a release built
purely from sources would be missing most of the solar system. A worked
example, converting the five bodies v0.0.1 has usable 4096 sources for:

```
=== set 4096 ===
  8 map(s) taken from the overlay, the rest from the checkout
    EnceladusBiomes, EnceladusColor, EuropaColor, EuropaHeight, Europa_NRM,
    MimasColor, NeptuneColor, RheaColor
```

The resulting archives extract to a tree that passes `verify.mjs`.

**The release workflow now passes `--overlay` by default**, so published
assets contain converted textures wherever sources allow. The job summary in
the Actions UI lists exactly which maps came from conversion, so an in-game
test knows what it is testing.

What that means for a release built today:

| Set | Maps conversion can feed | Rest |
| --- | --- | --- |
| 4096 | 17 (every shipping map with a source) | from the checkout |
| 8192 | 14 | from the checkout |
| 16384 | 14 | from the checkout |

Still unproven, and worth knowing before trusting a build: converted output has
never been loaded by KSP, colour mips are averaged in sRGB rather than linear
light, and the header normalisation is unverified in game. That is precisely
what publishing these assets is meant to find out.

## Why this exists

`build.pl` only knows the 2048/4096/8192 sets and cannot produce the 16384
pack at all, and Travis has not run since travis-ci.org shut down.

## Usage

```sh
# What would each asset contain? Compresses nothing, takes a second.
node tools/build/build.mjs --all --split groups --dry-run

# Build one set
node tools/build/build.mjs --set 8192 --out dist

# Build everything, splitting only where an asset would breach the limit
node tools/build/build.mjs --all --out dist
```

| Option | Default | Effect |
| --- | --- | --- |
| `--set <name>` | — | Build one set. Repeatable. |
| `--all` | — | Build every set in the manifest. |
| `--split <mode>` | `auto` | `none` one asset per set; `groups` one per planetary system; `auto` splits only when an asset would breach `--limit`. |
| `--limit <MiB>` | `1900` | Split threshold. GitHub's hard cap is 2048 MiB. |
| `--level <0-9>` | `6` | Deflate level. |
| `--dry-run` | — | Report contents and raw sizes without compressing. |

`auto` is the useful default: it leaves the smaller packs as single assets, so
the existing `RSSTextures4096` / `RSSTextures8192` CKAN krefs keep resolving,
and only splits the pack that has to be split.

Compressed size cannot be known before compressing, so `auto` estimates at 48%
of raw — the ratio the v18.6.1 assets came out at. Files absent from the
checkout are sized from the manifest rather than skipped, and the run says how
many were inferred that way; without that the 16384 set would price itself at a
third of reality and decide it needs no split.

Current estimates: 4096 at 452 MiB, 8192 at 921 MiB, 16384 at **1991 MiB**
against a 1900 MiB threshold — so `auto` now splits the 16k pack into ten
per-group assets, and leaves the other two as single assets.

It tipped over when `Saturn_NRM` was declared: 16384x8192 DXT5 with a full mip
chain is 170.7 MiB on its own. That was the predicted trigger and `auto`
flipped without being asked, but it is not a silent change — **a split 16384
release needs its NetKAN PR to land with it**, for the reason in
[Asset naming and CKAN](#asset-naming-and-ckan) below. Until that is ready,
`--split none --limit 2048` still produces a single `16384.zip`, which fits
under GitHub's hard cap but not by much.

## Determinism

Two builds of the same inputs produce byte-identical archives. Fixed DOS
timestamps, fixed version and attribute fields, no extra fields, entries sorted
by archive path. That is what makes "this refactor changed nothing" a
checkable claim rather than an assertion.

The writer is ~190 lines against Node's built-in `zlib`, so there is no
dependency to install in CI. It does not implement zip64; it throws rather than
emit a broken archive if an entry or an archive would exceed 4 GiB.

## Checking a build

```sh
node tools/build/build.mjs --set 4096 --out dist

mkdir -p check/extract check/root
for z in dist/*.zip; do unzip -oq "$z" -d check/extract; done
mv check/extract/GameData/RSS-Textures check/root/4096
node tools/manifest/verify.mjs --root check/root --sets 4096
```

Confirmed on the 4096 set: 11 assets, all pass `unzip -t`, byte-identical
across two independent builds, 110 of 110 extracted textures hash-identical to
their repository sources, and the extracted tree verifies against the manifest.

## Asset naming and CKAN

Split assets are named `RSS-Textures-<set>-<Group>.zip`. Unsplit assets keep
the current `<set>.zip` name.

The existing netkans match by **unanchored substring**:

```json
"$kref": "#/ckan/github/KSP-RO/RSS-Textures/asset_match/8192"
```

so publishing `RSS-Textures-8192-Earth.zip` alongside `8192.zip` makes that
match ambiguous. A release that splits a set must land together with a NetKAN
PR; it cannot be phased in by adding assets next to the old ones. The intended
shape on the CKAN side is a `"kind": "metapackage"` keeping the existing
`RSSTextures8192` identifier and depending on one module per group, so users
still install a single thing.

## Group sizes

From a real build of the 4096 set, and a dry run of the others. Compressed
sizes for 16384 are from the published v18.6.1 assets, since 17 of its
textures exceed GitHub's 100 MiB file limit and are absent from a checkout.

| Group | 4096 zip | 16384 zip (shipped) |
| --- | --- | --- |
| Earth (+ Moon) | 89.8 MiB | 654.6 MiB |
| Uranus (+ 5 moons) | 83.0 MiB | 85.4 MiB |
| Jupiter (+ 4 moons) | 81.0 MiB | 296.3 MiB |
| Saturn (+ 7 moons) | 46.4 MiB | 147.2 MiB |
| Pluto (+ Charon) | 43.7 MiB | 120.9 MiB |
| Mars (+ Phobos, Deimos) | 31.2 MiB | 307.6 MiB |
| Venus | 19.3 MiB | 76.5 MiB |
| Mercury | 14.3 MiB | 109.1 MiB |
| Belt (Vesta, Ceres) | 9.1 MiB | 7.4 MiB |
| Neptune (+ Triton) | 4.2 MiB | 42.7 MiB |

Largest group is Earth + Moon at 655 MiB, against a 2048 MiB cap. Room for it
to roughly triple. The gas giant moon upgrades land on Jupiter and Saturn,
both of which have more headroom than that.

## Known gaps

- **The 16384 set cannot be built from a checkout.** 17 textures exceed
  GitHub's 100 MiB file limit and exist only inside the published release zip.
  The build omits them and says so. Until sources move somewhere that can hold
  them, a real 16k release needs those files supplied out of band.
- **No conversion.** Set targets come from pre-built directories rather than
  being derived from `native` and `format`, so the manifest's intent is checked
  but not yet enforced by construction.
- **Deflate level is not tuned.** Level 6 across the board. The published
  v18.6.1 `4096.zip` is 406 MiB where this build totals 422 MiB across 11
  assets; some of that is the README repeated in each asset, the rest has not
  been investigated.
