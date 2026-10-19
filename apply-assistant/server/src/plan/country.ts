/**
 * Finds the one country a job location names, so work-authorisation questions can be answered
 * from your "countries I can work in" bank entry. Country names come from Node's ICU data;
 * a short alias table covers abbreviations and the main cities in your target markets.
 */

const ALIASES: Record<string, string> = {
  uk: "United Kingdom",
  "u.k.": "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  usa: "United States",
  "u.s.": "United States",
  "u.s.a.": "United States",
  us: "United States",
  uae: "United Arab Emirates",
  holland: "Netherlands",
  "the netherlands": "Netherlands",
  bangalore: "India",
  bengaluru: "India",
  hyderabad: "India",
  pune: "India",
  chennai: "India",
  mumbai: "India",
  delhi: "India",
  "new delhi": "India",
  gurgaon: "India",
  gurugram: "India",
  noida: "India",
  kolkata: "India",
  london: "United Kingdom",
  manchester: "United Kingdom",
  edinburgh: "United Kingdom",
  berlin: "Germany",
  munich: "Germany",
  münchen: "Germany",
  hamburg: "Germany",
  frankfurt: "Germany",
  amsterdam: "Netherlands",
  rotterdam: "Netherlands",
  eindhoven: "Netherlands",
  dublin: "Ireland",
  stockholm: "Sweden",
  copenhagen: "Denmark",
  tokyo: "Japan",
  osaka: "Japan",
  "san francisco": "United States",
  "new york": "United States",
  seattle: "United States",
};

function countryNames(): Map<string, string> {
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const names = new Map<string, string>();
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters)
    for (const b of letters) {
      const name = display.of(`${a}${b}`);
      if (name && name !== `${a}${b}` && !/unknown/i.test(name))
        names.set(name.toLowerCase(), name);
    }
  return names;
}

const NAMES: ReadonlyMap<string, string> = new Map([
  ...countryNames(),
  ...Object.entries(ALIASES),
]);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = [...NAMES.entries()]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([alias, country]) => ({
    country,
    pattern: new RegExp(
      `(^|[^\\p{L}])${escapeRegExp(alias)}(?=$|[^\\p{L}])`,
      "iu",
    ),
  }));

/** The single country named in a location string, or null when none or several are named. */
export function countryOf(location: string): string | null {
  if (!location.trim()) return null;
  const found = new Set(
    PATTERNS.filter((p) => p.pattern.test(location)).map((p) => p.country),
  );
  return found.size === 1 ? ([...found][0] ?? null) : null;
}
