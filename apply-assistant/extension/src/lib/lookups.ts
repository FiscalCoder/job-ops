import {
  GREENHOUSE_BOARDS_API_ORIGIN,
  getJobDetails,
  getJobsFromBoard,
  isGreenhouseUrl,
  parseGreenhouseUrl,
  resolveGreenhouseSource,
} from "@career-boards/greenhouse";

/**
 * The extension half of the resolver: performs each lookup task the server hands out, from
 * this browser (your IP), and reports the result. Mirrors the server's task/result shapes in
 * apply-assistant/server/src/resolver/lookups.ts.
 */

export type LookupTask =
  | { type: "verify-job"; token: string; ghJobId: string; region: "us" | "eu" }
  | { type: "resolve-embedded"; ghJobId: string; pageUrl: string }
  | { type: "follow-short-link"; url: string }
  | { type: "list-board"; token: string }
  | { type: "find-board"; employer: string }
  | { type: "fetch-schema"; token: string; ghJobId: string };

export interface PendingLookup {
  readonly jobId: string;
  readonly employer: string;
  readonly title: string;
  readonly task: LookupTask;
}

export interface BoardJob {
  readonly id: string;
  readonly title: string;
  readonly location: string;
  readonly url: string;
}

export type LookupResult =
  | {
      type: "job";
      jobId: string;
      token: string;
      ghJobId: string;
      url: string;
      live: boolean;
    }
  | {
      type: "board";
      jobId: string;
      employer: string;
      token: string | null;
      method: string;
      jobs?: BoardJob[];
      details?: Record<string, string>;
    }
  | {
      type: "schema";
      jobId: string;
      token: string;
      ghJobId: string;
      payload: unknown;
    };

/** What the server answers to a result (subset the extension cares about). */
export interface ResultOutcome {
  readonly status: string;
  readonly ghJobIds?: string[];
  readonly ghUrl?: string;
  readonly reason?: string;
}

export interface LookupDeps {
  readonly fetch: typeof fetch;
  /** Called between outside requests, to stay polite. */
  readonly pause: () => Promise<void>;
  readonly submit: (result: LookupResult) => Promise<ResultOutcome>;
}

/** At most this many postings' descriptions are fetched to pick the match. */
const MAX_DETAILS = 8;
const API = `${GREENHOUSE_BOARDS_API_ORIGIN}/v1/boards`;

async function getJson(
  deps: LookupDeps,
  url: string,
): Promise<Record<string, unknown> | null> {
  await deps.pause();
  try {
    const res = await deps.fetch(url, {
      headers: { accept: "application/json" },
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const boardExists = async (deps: LookupDeps, token: string) =>
  (await getJson(deps, `${API}/${encodeURIComponent(token)}`)) !== null;

/** Company name → likely board tokens: "Platform Science Inc." → platformscience, platform-science, platform. */
export function slugGuesses(employer: string): string[] {
  const words = employer
    .toLowerCase()
    .normalize("NFKD")
    .replace(
      /\b(inc|llc|ltd|limited|gmbh|pvt|private|corp|corporation|technologies|technology|labs?|co)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set([words.join(""), words.join("-"), words[0] ?? ""])].filter(
    Boolean,
  );
}

/** Company name → its website domain, via Clearbit's free autocomplete. */
async function companyDomain(
  deps: LookupDeps,
  employer: string,
): Promise<string | null> {
  const data = (await getJson(
    deps,
    `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(employer)}`,
  )) as unknown;
  const first = Array.isArray(data)
    ? (data[0] as { domain?: unknown } | undefined)
    : undefined;
  return typeof first?.domain === "string" ? first.domain : null;
}

export async function findBoard(
  deps: LookupDeps,
  employer: string,
): Promise<{ token: string; method: string } | null> {
  for (const token of slugGuesses(employer))
    if (await boardExists(deps, token)) return { token, method: "name-slug" };
  const domain = await companyDomain(deps, employer);
  if (!domain) return null;
  try {
    await deps.pause();
    const found = await resolveGreenhouseSource({
      url: `https://${domain}`,
      fetchImpl: deps.fetch,
    });
    return { token: found.token, method: `domain:${found.method}` };
  } catch {
    return null;
  }
}

async function listBoard(
  deps: LookupDeps,
  token: string,
): Promise<BoardJob[] | null> {
  try {
    await deps.pause();
    const { jobs } = await getJobsFromBoard({
      careersUrl: `https://job-boards.greenhouse.io/${token}`,
      fetchImpl: deps.fetch,
    });
    return jobs.map((j) => ({
      id: j.externalId,
      title: j.title,
      location: j.locationText ?? "",
      url: j.jobUrl,
    }));
  } catch {
    return null;
  }
}

async function jobDescriptions(
  deps: LookupDeps,
  token: string,
  ids: readonly string[],
) {
  const details: Record<string, string> = {};
  for (const id of ids.slice(0, MAX_DETAILS)) {
    try {
      await deps.pause();
      const { job } = await getJobDetails({
        jobRef: `${API}/${token}/jobs/${id}`,
        fetchImpl: deps.fetch,
      });
      details[id] = job.jobDescriptionHtml.slice(0, 150_000);
    } catch {
      /* a posting that vanished mid-lookup is simply left out */
    }
  }
  return details;
}

async function boardLookup(
  deps: LookupDeps,
  p: PendingLookup,
  token: string | null,
  method: string,
) {
  if (!token) {
    await deps.submit({
      type: "board",
      jobId: p.jobId,
      employer: p.employer,
      token: null,
      method,
    });
    return "no Greenhouse board";
  }
  const jobs = await listBoard(deps, token);
  if (!jobs) return `board ${token} unreachable`;
  const base = {
    type: "board" as const,
    jobId: p.jobId,
    employer: p.employer,
    token,
    method,
    jobs,
  };
  let outcome = await deps.submit(base);
  if (outcome.status === "need-details" && outcome.ghJobIds?.length) {
    outcome = await deps.submit({
      ...base,
      details: await jobDescriptions(deps, token, outcome.ghJobIds),
    });
  }
  return `board ${token}: ${outcome.status}${outcome.ghUrl ? ` ${outcome.ghUrl}` : ""}`;
}

async function verifyJob(
  deps: LookupDeps,
  jobId: string,
  token: string,
  ghJobId: string,
) {
  const posting = await getJson(
    deps,
    `${API}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(ghJobId)}`,
  );
  const url =
    typeof posting?.absolute_url === "string"
      ? posting.absolute_url
      : `https://job-boards.greenhouse.io/${token}/jobs/${ghJobId}`;
  const outcome = await deps.submit({
    type: "job",
    jobId,
    token,
    ghJobId,
    url,
    live: posting !== null,
  });
  return `posting ${outcome.status}`;
}

async function resolveEmbedded(
  deps: LookupDeps,
  jobId: string,
  pageUrl: string,
  ghJobId: string,
) {
  try {
    await deps.pause();
    const { token } = await resolveGreenhouseSource({
      url: pageUrl,
      fetchImpl: deps.fetch,
    });
    return verifyJob(deps, jobId, token, ghJobId);
  } catch {
    return "couldn't find the Greenhouse board behind that careers page";
  }
}

async function followShortLink(deps: LookupDeps, jobId: string, url: string) {
  let landed: string;
  try {
    await deps.pause();
    landed = (await deps.fetch(url, { redirect: "follow" })).url;
  } catch {
    return "short link unreachable";
  }
  const ghJid = new URL(landed).searchParams.get("gh_jid");
  const jobMatch = landed.match(/\/jobs\/(\d+)/);
  if (isGreenhouseUrl(landed) && jobMatch?.[1])
    return verifyJob(
      deps,
      jobId,
      parseGreenhouseUrl(landed).token,
      jobMatch[1],
    );
  if (ghJid) return resolveEmbedded(deps, jobId, landed, ghJid);
  return "short link doesn't lead to a Greenhouse posting";
}

async function fetchSchema(
  deps: LookupDeps,
  jobId: string,
  token: string,
  ghJobId: string,
) {
  const payload = await getJson(
    deps,
    `${API}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(ghJobId)}?questions=true`,
  );
  if (!payload) {
    const outcome = await deps.submit({
      type: "job",
      jobId,
      token,
      ghJobId,
      url: `https://job-boards.greenhouse.io/${token}/jobs/${ghJobId}`,
      live: false,
    });
    return `form gone: posting ${outcome.status}`;
  }
  const outcome = await deps.submit({
    type: "schema",
    jobId,
    token,
    ghJobId,
    payload,
  });
  return outcome.status === "planned"
    ? "form fetched, plan built"
    : `form: ${outcome.status}`;
}

/** Performs one lookup and reports to the server; returns a one-line description. */
export async function runTask(
  deps: LookupDeps,
  p: PendingLookup,
): Promise<string> {
  const { task } = p;
  switch (task.type) {
    case "verify-job":
      return verifyJob(deps, p.jobId, task.token, task.ghJobId);
    case "resolve-embedded":
      return resolveEmbedded(deps, p.jobId, task.pageUrl, task.ghJobId);
    case "follow-short-link":
      return followShortLink(deps, p.jobId, task.url);
    case "list-board":
      return boardLookup(deps, p, task.token, "cached");
    case "find-board": {
      const found = await findBoard(deps, task.employer);
      return boardLookup(
        deps,
        p,
        found?.token ?? null,
        found?.method ?? "name-slug+domain",
      );
    }
    case "fetch-schema":
      return fetchSchema(deps, p.jobId, task.token, task.ghJobId);
  }
}
