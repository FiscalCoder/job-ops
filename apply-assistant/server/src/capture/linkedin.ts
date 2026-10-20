/**
 * Pure helpers for LinkedIn apply-link capture. The extension reports which tab opened when you
 * clicked Apply on a LinkedIn job (never LinkedIn's page content); these turn that into the
 * job's id and the company link worth saving.
 */

const LINKEDIN_HOST = /(^|\.)linkedin\.com$/i;
const JOB_ID_PATTERNS = [
  /\/jobs\/view\/externalApply\/(\d{6,})/,
  /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})(?:[/?#]|$)/,
  /[?&]currentJobId=(\d{6,})/,
];

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** LinkedIn's job id from a job page, search page or externalApply link; null otherwise. */
export function linkedInJobIdOf(url: string): string | null {
  const parsed = parse(url);
  if (!parsed || !LINKEDIN_HOST.test(parsed.hostname)) return null;
  const path = `${parsed.pathname}${parsed.search}`;
  for (const pattern of JOB_ID_PATTERNS) {
    const id = pattern.exec(path)?.[1];
    if (id) return id;
  }
  return null;
}

const TRACKING_PARAM = /^(utm_[a-z]+|trk|trackingId|refId|li_fat_id)$/i;

/** A company link without tracking parameters; null for LinkedIn itself or non-web links. */
export function cleanApplyUrl(url: string): string | null {
  const parsed = parse(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return null;
  if (LINKEDIN_HOST.test(parsed.hostname)) return null;
  const kept = [...parsed.searchParams].filter(
    ([key]) => !TRACKING_PARAM.test(key),
  );
  parsed.search = new URLSearchParams(kept).toString();
  return parsed.toString();
}

/** Hosts of application systems whose links are worth keeping as-is. */
const KNOWN_ATS =
  /(greenhouse\.io|grnh\.se|lever\.co|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|icims\.com|taleo\.net|oraclecloud\.com|successfactors\.(com|eu)|jobvite\.com|workable\.com|recruitee\.com|bamboohr\.com|rippling\.com|teamtailor\.com|personio\.(de|com)|breezy\.hr|zohorecruit\.|darwinbox\.in|keka\.com|freshteam\.com)$/i;
/** Job-ad redirectors that only bounce the click on to the real page. */
const REDIRECTOR =
  /(^click\.|appcast\.io|joveo\.com|recruitics\.com|pandologic\.com|clickcast\.|jobadx\.)/i;

const hostOf = (url: string) => parse(url)?.hostname ?? "";

/** The link to save: where the tab ended up when that's an ATS or the first was a redirector. */
export function bestApplyLink(first: string, final: string | null): string {
  if (!final || final === first) return first;
  if (KNOWN_ATS.test(hostOf(final))) return final;
  if (REDIRECTOR.test(hostOf(first))) return final;
  return first;
}
