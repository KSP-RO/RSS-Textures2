// Splitting a texture filename into body and map kind, and matching the names
// source assets arrive under to the names the manifest uses.
//
// Lives in lib/ rather than in scan.mjs so that scan.mjs is only ever an entry
// point. A module that is both an entry point and an import needs an
// "am I main?" guard, and getting that guard subtly wrong makes the script a
// silent no-op on one platform - which is exactly what happened here.

// Canonical kind names - the spelling the shipped DDS files use. "_NRM"
// carries its separator because that is how those files are named; the
// matching below treats the underscore as optional, so NRM and _NRM both
// resolve here.
export const KIND_SUFFIXES = ['Biomes', 'Color', 'Height', 'Surface', 'Ring', '_NRM'];

/**
 * Alternative spellings a source file may use for a kind, lowercased.
 *
 * The source repository does not use the pack's names. Its assets are written
 * <Body>_<Kind>.png with `Normal` where the pack says `_NRM`, and `Rings`
 * where the pack says `Ring`. Both appear in v0.0.1: 25 files named
 * `<Body>_Normal.png` and one `Saturn_Rings.png`.
 *
 * Only spellings actually observed in a source release are listed. Guessing at
 * more would make matching loose enough to pair up two different textures,
 * which is the failure this whole mechanism exists to prevent.
 */
export const KIND_ALIASES = {
  normal: '_NRM',
  nrm: '_NRM',
  rings: 'Ring',
  ring: 'Ring',
  biomes: 'Biomes',
  color: 'Color',
  height: 'Height',
  surface: 'Surface',
};

/**
 * Fold a map name to a form that ignores case and underscore separators.
 *
 *   EarthColor  Earth_Color  earth_color  EARTHCOLOR   ->  earthcolor
 *   Earth_NRM   EarthNRM     earth_nrm                 ->  earthnrm
 *
 * Source assets are authored by hand by several people, so "EarthColor.png"
 * and "Earth_Color.png" both turn up and both mean the same texture. Requiring
 * one exact spelling makes a file silently invisible to the build, which looks
 * identical to the file simply not existing yet.
 *
 * Only case and "_" are folded. Hyphens and spaces are left alone: the point
 * is to accept the separators people actually use for this, not to make
 * matching loose enough to pair up two genuinely different textures. All 127
 * map names in the manifest stay distinct under this fold.
 */
export function normalizeMapName(name) {
  // Canonicalise the kind first, so Earth_Normal and Earth_NRM fold together
  // even though "normal" and "nrm" share no letters.
  return canonicalMapName(name).toLowerCase().replace(/_/g, '');
}

/**
 * A source filename rewritten in the pack's own spelling.
 *
 *   Earth_Normal -> Earth_NRM      Saturn_Rings -> SaturnRing
 *   Earth_Color  -> EarthColor     earth_height -> earthHeight
 *
 * The body keeps the case it was written with; only the kind is rewritten.
 * Anything whose kind is unrecognised comes back unchanged.
 */
export function canonicalMapName(name) {
  const { body, kind } = splitMapName(name);
  return kind === 'Other' ? name : body + kind;
}

/**
 * "Earth_NRM" -> { body: "Earth", kind: "_NRM" }
 * "SaturnRing" -> { body: "Saturn", kind: "Ring" }
 * "Earth_Color" -> { body: "Earth", kind: "Color" }
 *
 * The kind comes back in its canonical spelling whatever the file used. The
 * body keeps the case it was written with, because for a map the manifest has
 * never seen that is the only spelling available; use canonicalMapName to
 * resolve against the manifest when an entry already exists.
 *
 * Anything unrecognised comes back as kind "Other" rather than throwing, so a
 * new filename shows up in reports instead of stopping a scan.
 */
export function splitMapName(base) {
  // Longest spelling first, so "Rings" is tried before "Ring" and a file named
  // Saturn_Rings does not come back as body "Saturn_" kind "Ring".
  const spellings = Object.keys(KIND_ALIASES).sort((a, b) => b.length - a.length);
  for (const spelling of spellings) {
    // Optional "_" before the kind, case-insensitive, anchored at the end.
    const m = base.match(new RegExp('^(.*?)_?' + spelling + '$', 'i'));
    if (m && m[1].length > 0) return { body: m[1], kind: KIND_ALIASES[spelling] };
  }
  return { body: base, kind: 'Other' };
}

/**
 * Index a manifest's map names by their normalized form, so a source file can
 * be matched back to the canonical name regardless of how it was spelled.
 */
export function manifestMapIndex(manifest) {
  const index = new Map();
  for (const [bodyName, body] of Object.entries(manifest.bodies)) {
    for (const kind of Object.keys(body.maps)) {
      index.set(normalizeMapName(bodyName + kind), bodyName + kind);
    }
  }
  // Shared textures belong to no body, so they are not reachable through
  // bodies/maps - but they are declared, and a caller asking "does the manifest
  // know this name" must be told yes. Leaving them out made Flat_NRM.png in a
  // source archive look like art nobody had declared.
  for (const mapName of Object.keys(manifest.shared ?? {})) {
    index.set(normalizeMapName(mapName), mapName);
  }
  return index;
}
