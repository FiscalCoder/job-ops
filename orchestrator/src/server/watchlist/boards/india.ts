import {
  type BoardPosting,
  type BoardRef,
  type BoardSpec,
  isoDate,
  readBoardJson,
  readBoardUrl,
} from "../board-adapter";

/**
 * Job boards on ATSes many Indian companies use. Each has a public list with no login; the
 * request shapes follow career-ops' providers (MIT, github.com/career-ops-hq/career-ops):
 * keka.mjs, darwinbox.mjs, zoho-recruit.mjs.
 */

const str = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const idOf = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : str(value);
const httpsUrl = (input: string): URL | null => {
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

// ---------- Keka: https://<tenant>.keka.com/careers ----------

const KEKA_HOST = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.keka\.com$/;
const KEKA_RESERVED = new Set(["www", "app", "api", "help", "support", "blog", "docs", "status", "mail", "developers"]);
/** The tenant's feed id, in the careers page's fragment path. */
const KEKA_FEED_ID =
  /\/ats\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/careerportal\//i;

export function kekaLocation(row: Record<string, unknown>): string {
  const places = Array.isArray(row.jobLocations) ? row.jobLocations : [];
  const parts: string[] = [];
  for (const place of places) {
    if (!place || typeof place !== "object") continue;
    const p = place as Record<string, unknown>;
    const label = [str(p.city), str(p.countryName)].filter(Boolean).join(", ") || str(p.name);
    if (label && !parts.includes(label)) parts.push(label);
  }
  return parts.join("; ");
}

export function parseKekaJobs(json: unknown, board: BoardRef): BoardPosting[] {
  if (!Array.isArray(json)) throw new Error("Keka returned an unexpected job list");
  const origin = new URL(board.careersUrl).origin;
  return json.flatMap((row): BoardPosting[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = idOf(r.id);
    const title = str(r.title);
    if (!id || !title) return [];
    return [
      {
        id,
        title,
        jobUrl: `${origin}/careers/jobdetails/${encodeURIComponent(id)}`,
        location: kekaLocation(r) || null,
        postedAt: isoDate(r.publishedOn),
        descriptionHtml: typeof r.description === "string" ? r.description : null,
      },
    ];
  });
}

export const kekaBoard: BoardSpec = {
  sourceType: "keka",
  label: "Keka",
  placeholder: "https://company.keka.com/careers",
  helpText: "Paste the company's Keka careers page: https://<company>.keka.com/careers",
  parse(url) {
    const parsed = httpsUrl(url);
    const tenant = parsed?.hostname.toLowerCase().match(KEKA_HOST)?.[1];
    if (!tenant || KEKA_RESERVED.has(tenant)) return null;
    return { key: tenant, careersUrl: `https://${tenant}.keka.com/careers` };
  },
  async fetchPostings(board, signal) {
    const page = await readBoardUrl(board.careersUrl, { signal, accept: "text/html" });
    const feedId = page.match(KEKA_FEED_ID)?.[1]?.toLowerCase();
    // No id: Keka changed its page, not an empty board.
    if (!feedId) throw new Error("Keka's careers page has no job feed id (it may have changed)");
    const origin = new URL(board.careersUrl).origin;
    return parseKekaJobs(
      await readBoardJson(`${origin}/careers/api/embedjobs/default/active/${feedId}`, { signal }),
      board,
    );
  },
};

// ---------- Darwinbox: https://<tenant>.darwinbox.in/ms/candidatev2/<companyId>/careers ----------

const DARWINBOX_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.darwinbox\.in$/;
const DARWINBOX_PATH = /^\/ms\/candidatev2\/([a-z0-9_-]+)\/careers(?:\/|$)/i;
const DARWINBOX_PAGE = 50;
const DARWINBOX_MAX_PAGES = 20;

export function parseDarwinboxJobs(json: unknown, board: BoardRef): BoardPosting[] {
  const body = json as { status?: unknown; data?: unknown } | null;
  if (body?.status !== "success" || !Array.isArray(body.data))
    throw new Error("Darwinbox returned an unexpected job list");
  const base = board.careersUrl.replace(/\/allJobs$/, "");
  return body.data.flatMap((row): BoardPosting[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = idOf(r.id);
    const title = str(r.title);
    if (!id || !title) return [];
    const places = (Array.isArray(r.tool_tip_locations) && r.tool_tip_locations.length
      ? r.tool_tip_locations
      : [r.locations]
    )
      .map(str)
      .filter(Boolean);
    return [
      {
        id,
        title,
        jobUrl: `${base}/jobDetails/${encodeURIComponent(id)}`,
        location: [...new Set(places)].join("; ") || null,
        postedAt: isoDate(r.posted_on) ?? isoDate(r.created_on),
        descriptionHtml: typeof r.jd === "string" ? r.jd : null,
      },
    ];
  });
}

export const darwinboxBoard: BoardSpec = {
  sourceType: "darwinbox",
  label: "Darwinbox",
  placeholder: "https://company.darwinbox.in/ms/candidatev2/a1b2c3/careers/allJobs",
  helpText:
    "Paste the company's Darwinbox careers page: https://<company>.darwinbox.in/ms/candidatev2/<id>/careers/allJobs",
  parse(url) {
    const parsed = httpsUrl(url);
    if (!parsed || !DARWINBOX_HOST.test(parsed.hostname.toLowerCase())) return null;
    const companyId = parsed.pathname.match(DARWINBOX_PATH)?.[1];
    if (!companyId) return null;
    const host = parsed.hostname.toLowerCase();
    return {
      key: `${host.split(".")[0]}-${companyId}`,
      careersUrl: `https://${host}/ms/candidatev2/${companyId}/careers/allJobs`,
    };
  },
  async fetchPostings(board, signal) {
    const url = new URL(board.careersUrl);
    const companyId = url.pathname.match(DARWINBOX_PATH)?.[1] ?? "";
    const endpoint = `${url.origin}/ms/candidateapi/job/alljobs?companyId=${encodeURIComponent(companyId)}`;
    const postings = new Map<string, BoardPosting>();
    for (let page = 1; page <= DARWINBOX_MAX_PAGES; page += 1) {
      const json = await readBoardJson(endpoint, {
        signal,
        method: "POST",
        body: JSON.stringify({ companyId, page, sort_option: "new", limit: DARWINBOX_PAGE }),
      });
      const found = parseDarwinboxJobs(json, board);
      for (const posting of found) postings.set(posting.id, posting);
      if ((json as { data: unknown[] }).data.length < DARWINBOX_PAGE) break;
    }
    return [...postings.values()];
  },
};

// ---------- Zoho Recruit: https://<tenant>.zohorecruit.<tld>/jobs/Careers ----------

const ZOHO_HOST = /^([a-z0-9][a-z0-9-]*)\.zohorecruit\.(?:com|ca|eu|in|com\.au|jp|sa|com\.cn)$/;
/** The board's postings, as JSON in the careers page's `<input id="jobs" value="…">`. */
const ZOHO_INPUT = /<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

const decodeEntities = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");

export function parseZohoJobs(html: string, board: BoardRef): BoardPosting[] {
  let value: string | null = null;
  for (const [tag] of html.matchAll(ZOHO_INPUT)) {
    if (!/\sid\s*=\s*["']?jobs["'\s/>]/i.test(tag)) continue;
    const attr = tag.match(/\svalue\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    value = attr ? (attr[1] ?? attr[2] ?? "") : "";
    break;
  }
  if (value === null)
    throw new Error("Zoho Recruit's careers page has no job list (unknown company, or an old career site)");
  let records: unknown;
  try {
    records = JSON.parse(decodeEntities(value));
  } catch {
    throw new Error("Zoho Recruit's job list isn't valid JSON");
  }
  if (!Array.isArray(records)) throw new Error("Zoho Recruit returned an unexpected job list");
  const origin = new URL(board.careersUrl).origin;
  return records.flatMap((row): BoardPosting[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (r.Is_Locked === true || r.Publish === false) return [];
    const id = idOf(r.id);
    const title = str(r.Posting_Title) || str(r.Job_Opening_Name);
    if (!id || !title) return [];
    const place = [str(r.City), str(r.State), str(r.Country)].filter(Boolean);
    if (r.Remote_Job === true) place.push("Remote");
    return [
      {
        id,
        title,
        jobUrl: `${origin}/jobs/Careers/${encodeURIComponent(id)}`,
        location: [...new Set(place)].join(", ") || null,
        postedAt: isoDate(r.Date_Opened),
        descriptionHtml: typeof r.Job_Description === "string" ? r.Job_Description : null,
      },
    ];
  });
}

export const zohoRecruitBoard: BoardSpec = {
  sourceType: "zoho-recruit",
  label: "Zoho Recruit",
  placeholder: "https://company.zohorecruit.in/jobs/Careers",
  helpText: "Paste the company's Zoho Recruit careers page: https://<company>.zohorecruit.in/jobs/Careers",
  parse(url) {
    const parsed = httpsUrl(url);
    const host = parsed?.hostname.toLowerCase() ?? "";
    const tenant = host.match(ZOHO_HOST)?.[1];
    if (!tenant) return null;
    return { key: tenant, careersUrl: `https://${host}/jobs/Careers` };
  },
  async fetchPostings(board, signal) {
    return parseZohoJobs(
      await readBoardUrl(board.careersUrl, { signal, accept: "text/html" }),
      board,
    );
  },
};
