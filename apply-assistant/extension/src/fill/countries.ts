/** Both normalised: the whole choice 0, its start ("india +91") 1, among its words 2; else 9. */
function rankName(label: string, name: string): number {
  if (!name) return 9;
  if (label === name) return 0;
  const words = (t: string) => ` ${t.replace(/[^\p{L}\p{N}+]+/gu, " ").trim()} `;
  if (words(label).startsWith(words(name))) return 1;
  return words(label).includes(words(name)) ? 2 : 9;
}

/**
 * Countries as dropdowns list them: a phone field's country picker shows "+91", "IN +91",
 * "India (+91)" or "🇮🇳 India"; an address list "United States" or "USA". Name, ISO code,
 * dialling code, other names.
 */
type Country = readonly [name: string, iso: string, dial: string, ...others: string[]];
const COUNTRIES: readonly Country[] = [
  ["India", "IN", "+91", "Bharat"],
  ["United States", "US", "+1", "United States of America", "USA", "U.S.", "U.S.A.", "America"],
  ["United Kingdom", "GB", "+44", "UK", "U.K.", "Great Britain", "England", "Britain"],
  ["Canada", "CA", "+1"],
  ["Australia", "AU", "+61"],
  ["Germany", "DE", "+49", "Deutschland"],
  ["France", "FR", "+33"],
  ["Netherlands", "NL", "+31", "Holland", "The Netherlands"],
  ["Ireland", "IE", "+353"],
  ["Singapore", "SG", "+65"],
  ["United Arab Emirates", "AE", "+971", "UAE", "U.A.E."],
  ["Saudi Arabia", "SA", "+966"],
  ["Qatar", "QA", "+974"],
  ["Japan", "JP", "+81"],
  ["China", "CN", "+86"],
  ["Hong Kong", "HK", "+852"],
  ["South Korea", "KR", "+82", "Korea", "Republic of Korea", "Korea, Republic of"],
  ["Malaysia", "MY", "+60"],
  ["Indonesia", "ID", "+62"],
  ["Philippines", "PH", "+63"],
  ["Vietnam", "VN", "+84", "Viet Nam"],
  ["Thailand", "TH", "+66"],
  ["Sri Lanka", "LK", "+94"],
  ["Bangladesh", "BD", "+880"],
  ["Pakistan", "PK", "+92"],
  ["Nepal", "NP", "+977"],
  ["New Zealand", "NZ", "+64"],
  ["Spain", "ES", "+34"],
  ["Italy", "IT", "+39"],
  ["Portugal", "PT", "+351"],
  ["Switzerland", "CH", "+41"],
  ["Sweden", "SE", "+46"],
  ["Norway", "NO", "+47"],
  ["Denmark", "DK", "+45"],
  ["Finland", "FI", "+358"],
  ["Poland", "PL", "+48"],
  ["Belgium", "BE", "+32"],
  ["Austria", "AT", "+43"],
  ["Israel", "IL", "+972"],
  ["Brazil", "BR", "+55"],
  ["Mexico", "MX", "+52"],
  ["South Africa", "ZA", "+27"],
  ["Egypt", "EG", "+20"],
  ["Nigeria", "NG", "+234"],
  ["Kenya", "KE", "+254"],
  ["Romania", "RO", "+40"],
  ["Czech Republic", "CZ", "+420", "Czechia"],
  ["Hungary", "HU", "+36"],
  ["Ukraine", "UA", "+380"],
  ["Turkey", "TR", "+90", "Türkiye", "Turkiye"],
  ["Taiwan", "TW", "+886"],
  ["Argentina", "AR", "+54"],
  ["Chile", "CL", "+56"],
  ["Colombia", "CO", "+57"],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/[().]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The country an answer names ("India", "IN", "+91", "india (+91)"); undefined when none. */
export function countryOf(text: string): Country | undefined {
  const t = norm(text);
  if (!t) return undefined;
  const byName = COUNTRIES.find((c) =>
    [c[0], ...c.slice(3)].some((n) => norm(n) === t || t.startsWith(`${norm(n)} +`)),
  );
  if (byName) return byName;
  const code = /^\+?\d{1,4}$/.test(t.replace(/\s/g, "")) ? `+${t.replace(/\D/g, "")}` : "";
  // +1 is the US and Canada both: the first listed.
  if (code) return COUNTRIES.find((c) => c[2] === code);
  return COUNTRIES.find((c) => c[1].toLowerCase() === t);
}

/**
 * The choice that's the answer's country when no choice words it the same: "India" picks
 * "+91", "IN +91", "🇮🇳 India (+91)" or "Bharat". A code alone ("IN") only as a whole
 * choice, or one starting with it ("IN +91"). Null when the answer isn't a country, or no
 * choice is it.
 */
export function bestCountryOption(labels: readonly string[], wanted: string): number | null {
  const country = countryOf(wanted);
  if (!country) return null;
  const [name, iso, dial, ...others] = country;
  const names = [name, ...others];
  let best: { index: number; rank: number } | null = null;
  for (const [index, label] of labels.entries()) {
    const l = norm(label);
    const rank = Math.min(
      ...names.map((n) => rankName(l, norm(n))),
      // "+91" stands for India where it's the choice's only words, or beside the ISO code.
      new RegExp(`^(${iso.toLowerCase()} )?\\${dial}$`).test(l) ? 1 : 9,
      l === iso.toLowerCase() || l.startsWith(`${iso.toLowerCase()} +`) ? 1 : 9,
      // A choice naming the code among other words ("India +91" already matched by name).
      new RegExp(`(^|[^\\d+])\\${dial}(?!\\d)`).test(l) ? 4 : 9,
    );
    if (rank < 9 && (!best || rank < best.rank || (rank === best.rank && label.length < (labels[best.index]?.length ?? 0))))
      best = { index, rank };
  }
  return best?.index ?? null;
}

/** The field shows the answer's country another way ("+91" or "IN" for "India"). */
export function showsCountry(shown: string, wanted: string): boolean {
  const want = countryOf(wanted);
  if (!want) return false;
  const got = countryOf(shown.replace(/^.*?(\+\d{1,4}).*$/, "$1")) ?? countryOf(shown);
  // +1: either country the code is for.
  return !!got && (got === want || (got[2] === want[2] && want[2] === "+1"));
}
