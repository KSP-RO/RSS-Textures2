// The resolution sets we build and publish.
//
// 2048 was dropped: it is no longer supported. The directory may still exist
// in a checkout and older releases still carry a 2048.zip, so tools take a
// --sets override for inspecting historical trees.
//
// Note for whoever retires a set from CKAN: the netkan krefs match release
// assets by unanchored substring ("asset_match/2048"), so an asset whose name
// merely contains the number is enough to keep an obsolete module resolving.
export const SETS = ['4096', '8192', '16384'];

export const RETIRED_SETS = ['2048'];

/** Parse a --sets a,b,c override, validating against known set names. */
export function parseSets(value) {
  const wanted = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set([...SETS, ...RETIRED_SETS]);
  for (const s of wanted) {
    if (!known.has(s)) throw new Error('unknown set: ' + s + ' (known: ' + [...known].join(', ') + ')');
  }
  return wanted;
}
