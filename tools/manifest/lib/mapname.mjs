// Splitting a texture filename into body and map kind.
//
// Lives in lib/ rather than in scan.mjs so that scan.mjs is only ever an entry
// point. A module that is both an entry point and an import needs an
// "am I main?" guard, and getting that guard subtly wrong makes the script a
// silent no-op on one platform - which is exactly what happened here.

// Order matters only in that each suffix is matched exactly; "Color" and
// "Surface" are distinct kinds, not prefixes of each other.
export const KIND_SUFFIXES = ['Biomes', 'Color', 'Height', 'Surface', 'Ring', '_NRM'];

/**
 * "Earth_NRM" -> { body: "Earth", kind: "_NRM" }
 * "SaturnRing" -> { body: "Saturn", kind: "Ring" }
 * Anything unrecognised comes back as kind "Other" rather than throwing, so a
 * new filename shows up in reports instead of stopping a scan.
 */
export function splitMapName(base) {
  for (const suffix of KIND_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      return { body: base.slice(0, base.length - suffix.length), kind: suffix };
    }
  }
  return { body: base, kind: 'Other' };
}
