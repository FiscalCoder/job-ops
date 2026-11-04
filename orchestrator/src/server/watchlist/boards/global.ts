import {
  type BoardPosting,
  type BoardRef,
  type BoardSpec,
  isoDate,
  readBoardJson,
} from "../board-adapter";

/** Lever and SmartRecruiters company boards, from their public posting APIs. */

const str = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const httpsUrl = (input: string): URL | null => {
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// ---------- Lever: https://jobs.lever.co/<company> (or jobs.eu.lever.co) ----------

export function parseLeverJobs(json: unknown): BoardPosting[] {
  if (!Array.isArray(json)) throw new Error("Lever returned an unexpected job list");
  return json.flatMap((row): BoardPosting[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    const title = str(r.text);
    const jobUrl = str(r.hostedUrl);
    if (!id || !title || !jobUrl) return [];
    const categories = (r.categories ?? {}) as Record<string, unknown>;
    const places = Array.isArray(categories.allLocations)
      ? categories.allLocations.map(str).filter(Boolean)
      : [str(categories.location)].filter(Boolean);
    if (str(r.workplaceType) === "remote" && !places.includes("Remote")) places.push("Remote");
    // The description, then each list ("Requirements"), then the closing text.
    const lists = Array.isArray(r.lists)
      ? r.lists
          .map((list) => {
            const l = (list ?? {}) as Record<string, unknown>;
            return `<h3>${str(l.text)}</h3><ul>${typeof l.content === "string" ? l.content : ""}</ul>`;
          })
          .join("")
      : "";
    return [
      {
        id,
        title,
        jobUrl,
        applicationLink: str(r.applyUrl) || jobUrl,
        location: places.join("; ") || null,
        postedAt: isoDate(r.createdAt),
        descriptionHtml: `${typeof r.description === "string" ? r.description : ""}${lists}${typeof r.additional === "string" ? r.additional : ""}`,
      },
    ];
  });
}

export const leverBoard: BoardSpec = {
  sourceType: "lever",
  label: "Lever",
  placeholder: "https://jobs.lever.co/company",
  helpText: "Paste the company's Lever board: https://jobs.lever.co/<company>",
  parse(url) {
    const parsed = httpsUrl(url);
    const host = parsed?.hostname.toLowerCase();
    if (host !== "jobs.lever.co" && host !== "jobs.eu.lever.co") return null;
    const slug = parsed?.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!SLUG.test(slug)) return null;
    return { key: slug.toLowerCase(), careersUrl: `https://${host}/${slug.toLowerCase()}` };
  },
  async fetchPostings(board, signal) {
    const url = new URL(board.careersUrl);
    const api = url.hostname === "jobs.eu.lever.co" ? "api.eu.lever.co" : "api.lever.co";
    return parseLeverJobs(
      await readBoardJson(`https://${api}/v0/postings/${board.key}?mode=json`, { signal }),
    );
  },
};

// ---------- SmartRecruiters: https://jobs.smartrecruiters.com/<CompanyId> ----------

const SR_PAGE = 100;
const SR_MAX_PAGES = 10;
const SR_API = "https://api.smartrecruiters.com/v1/companies";

export function parseSmartRecruitersJobs(json: unknown, board: BoardRef): {
  postings: BoardPosting[];
  total: number;
} {
  const body = json as { content?: unknown; totalFound?: unknown } | null;
  if (!body || !Array.isArray(body.content))
    throw new Error("SmartRecruiters returned an unexpected job list");
  const postings = body.content.flatMap((row): BoardPosting[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    const title = str(r.name);
    if (!id || !title) return [];
    const place = (r.location ?? {}) as Record<string, unknown>;
    const location =
      str(place.fullLocation) ||
      [str(place.city), str(place.region), str(place.country)].filter(Boolean).join(", ");
    const company = (r.company ?? {}) as Record<string, unknown>;
    return [
      {
        id,
        title,
        jobUrl: `https://jobs.smartrecruiters.com/${board.key}/${encodeURIComponent(id)}`,
        location: [location, place.remote === true ? "Remote" : ""].filter(Boolean).join("; ") || null,
        postedAt: isoDate(r.releasedDate),
        employer: str(company.name) || null,
      },
    ];
  });
  return { postings, total: typeof body.totalFound === "number" ? body.totalFound : postings.length };
}

/** A posting's ad sections as one HTML description. */
export function smartRecruitersDescription(json: unknown): string | null {
  const sections = ((json as { jobAd?: { sections?: unknown } } | null)?.jobAd?.sections ??
    {}) as Record<string, { title?: unknown; text?: unknown } | undefined>;
  const html = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
    .map((name) => sections[name])
    .filter((s): s is { title?: unknown; text?: unknown } => Boolean(s && typeof s.text === "string"))
    .map((s) => `<h3>${str(s.title)}</h3>${String(s.text)}`)
    .join("");
  return html || null;
}

export const smartRecruitersBoard: BoardSpec = {
  sourceType: "smartrecruiters",
  label: "SmartRecruiters",
  placeholder: "https://jobs.smartrecruiters.com/Company",
  helpText: "Paste the company's SmartRecruiters board: https://jobs.smartrecruiters.com/<Company>",
  parse(url) {
    const parsed = httpsUrl(url);
    const host = parsed?.hostname.toLowerCase();
    if (host !== "jobs.smartrecruiters.com" && host !== "careers.smartrecruiters.com") return null;
    const company = parsed?.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!SLUG.test(company)) return null;
    return { key: company, careersUrl: `https://jobs.smartrecruiters.com/${company}` };
  },
  async fetchPostings(board, signal) {
    const all: BoardPosting[] = [];
    for (let page = 0; page < SR_MAX_PAGES; page += 1) {
      const { postings, total } = parseSmartRecruitersJobs(
        await readBoardJson(
          `${SR_API}/${encodeURIComponent(board.key)}/postings?limit=${SR_PAGE}&offset=${page * SR_PAGE}`,
          { signal },
        ),
        board,
      );
      all.push(...postings);
      if (postings.length < SR_PAGE || all.length >= total) break;
    }
    return all;
  },
  async fetchDescription(board, posting, signal) {
    return smartRecruitersDescription(
      await readBoardJson(
        `${SR_API}/${encodeURIComponent(board.key)}/postings/${encodeURIComponent(posting.id)}`,
        { signal },
      ),
    );
  },
};
