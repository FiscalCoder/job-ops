/**
 * Ask the posting's own ATS whether it's still listed, before reading its page: a public
 * API answers plainly where a page may be an app shell, a login wall (LinkedIn) or a bot wall.
 * Tried on the job's page link and on where you apply (a LinkedIn job's Greenhouse link).
 * Only a clear answer counts; anything else returns null and the page check runs as before.
 *
 * After career-ops' liveness-api.mjs (MIT, github.com/career-ops-hq/career-ops).
 */

import type { LivenessVerdict } from "./classify";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type Answer = { status: number; body: string };
export type ReadApi = (url: string, timeoutMs: number) => Promise<Answer>;

async function readApi(url: string, timeoutMs: number): Promise<Answer> {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  const body = await response.text();
  return { status: response.status, body: body.slice(0, 2_000_000) };
}

const closed = (reason: string): LivenessVerdict => ({ state: "closed", reason });
const live = (reason: string): LivenessVerdict => ({ state: "live", reason });

interface Probe {
  readonly api: string;
  /** The verdict from the API's answer; null when the answer isn't clear. */
  readonly judge: (answer: Answer) => LivenessVerdict | null;
}

/** The API request that answers for a posting link, when its ATS has one. */
export function probeFor(link: string): Probe | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split("/").filter(Boolean);

  // Greenhouse: boards.greenhouse.io/<board>/jobs/<id> (job-boards.… too).
  if (/^(boards|job-boards)\.greenhouse\.io$/.test(host)) {
    const [board, jobs, id] = seg;
    if (board && SLUG.test(board) && jobs === "jobs" && id && /^\d+$/.test(id))
      return {
        api: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
        judge: ({ status }) =>
          status === 200
            ? live("Greenhouse still lists the posting")
            : status === 404
              ? closed("Greenhouse no longer lists the posting")
              : null,
      };
  }

  // Lever: jobs.lever.co/<company>/<uuid>.
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    const [company, id] = seg;
    if (company && SLUG.test(company) && id && UUID.test(id)) {
      const api = host === "jobs.eu.lever.co" ? "api.eu.lever.co" : "api.lever.co";
      return {
        api: `https://${api}/v0/postings/${company}/${id}`,
        judge: ({ status }) =>
          status === 200
            ? live("Lever still lists the posting")
            : status === 404
              ? closed("Lever no longer lists the posting")
              : null,
      };
    }
  }

  // SmartRecruiters: jobs.smartrecruiters.com/<Company>/<id>-<slug>.
  if (host === "jobs.smartrecruiters.com") {
    const [company, rest] = seg;
    const id = rest?.match(/^(\d{6,})/)?.[1];
    if (company && SLUG.test(company) && id)
      return {
        api: `https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`,
        judge: ({ status }) =>
          status === 200
            ? live("SmartRecruiters still lists the posting")
            : status === 404
              ? closed("SmartRecruiters no longer lists the posting")
              : null,
      };
  }

  // Workday: <tenant>.wdN.myworkdayjobs.com/[locale/]<site>/job/<…>: its CXS API by path.
  if (/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/.test(host)) {
    const at = seg.indexOf("job");
    const site = at > 0 ? seg[at - 1] : undefined;
    const tenant = host.split(".")[0];
    if (site && SLUG.test(site) && at + 1 < seg.length)
      return {
        api: `https://${host}/wday/cxs/${tenant}/${site}/${seg.slice(at).map(encodeURIComponent).join("/")}`,
        judge: ({ status, body }) => {
          if (status === 200 && body.includes("jobPostingInfo"))
            return live("Workday still lists the posting");
          if (status === 404) return closed("Workday no longer lists the posting");
          // Workday's own code for a withdrawn posting.
          if (status === 403 && /"S22"/.test(body))
            return closed("Workday says the posting was withdrawn");
          return null;
        },
      };
  }

  // Ashby: jobs.ashbyhq.com/<board>/<uuid>: listed on the board's public feed?
  if (host === "jobs.ashbyhq.com") {
    const [board, id] = seg;
    if (board && SLUG.test(board) && id && UUID.test(id))
      return {
        api: `https://api.ashbyhq.com/posting-api/job-board/${board}`,
        judge: ({ status, body }) => {
          if (status !== 200) return null;
          let jobs: unknown;
          try {
            jobs = (JSON.parse(body) as { jobs?: unknown }).jobs;
          } catch {
            return null;
          }
          if (!Array.isArray(jobs)) return null;
          const listed = jobs.some(
            (job) =>
              typeof job === "object" &&
              job !== null &&
              String((job as { id?: unknown }).id).toLowerCase() === id.toLowerCase(),
          );
          return listed
            ? live("Ashby still lists the posting")
            : closed("Ashby's board no longer lists the posting");
        },
      };
  }
  return null;
}

/** The ATS's own answer for the first link that has one; null when none answers clearly. */
export async function checkWithAtsApi(
  links: readonly (string | null | undefined)[],
  timeoutMs: number,
  read: ReadApi = readApi,
): Promise<LivenessVerdict | null> {
  for (const link of links) {
    const probe = link ? probeFor(link) : null;
    if (!probe) continue;
    const answer = await read(probe.api, timeoutMs).catch(() => null);
    const verdict = answer ? probe.judge(answer) : null;
    if (verdict) return verdict;
  }
  return null;
}
