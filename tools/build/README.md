# Release builder

Builds the release assets from `manifest/textures.json`. Replaces `bin/build.pl`
and the dead `.travis.yml`.

**Prototype.** There is no texture conversion here. Files are taken from the
existing per-set directories as-is, so a build is byte-identical to what is in
the repository and carries no visual risk. The seam where an encoder goes is
`resolveSource()` in `build.mjs` — it would take the source asset plus the
manifest's `format`/`mips`/`native` fields and produce the DDS instead of
looking one up. Nothing downstream changes when that is swapped.

Packaging is the part that is actually broken: `16384.zip` is at 95% of
GitHub's 2 GiB per-asset limit, `build.pl` has never been able to produce it,
and Travis has not run since travis-ci.org shut down.

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

Current estimates: 4096 at 362 MiB, 8192 at 709 MiB, 16384 at 1717 MiB against
a 1900 MiB threshold. So on intended formats the 16k pack still fits as one
asset — it is 1848 MiB today because six opaque colour maps ship as DXT5. The
gas giant moon upgrades are what tip it over, and `auto` flips on its own when
they land.

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
