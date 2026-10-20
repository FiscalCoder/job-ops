import {
  isGreenhouseUrl,
  parseGreenhouseUrl,
  resolveGreenhouseSource,
} from "@career-boards/greenhouse";
import { ashby } from "./boards/ashby";
import { greenhouse } from "./boards/greenhouse";
import { lever } from "./boards/lever";
import type { Ats, BoardApi, BoardJob, BoardListing } from "./boards/types";

/**
 * The extension half of the resolver: performs each lookup task the server hands out, from
 * this browser (your IP), and reports the result. Mirrors the server's task/result shapes in
 * apply-assistant/server/src/resolver/lookups.ts.
 */

export type { BoardJob };

export type LookupTask =
  | {
      type: "verify-job";
      ats: Ats;
      token: string;
      postingId: string;
      region: "us" | "eu";
    }
  | { type: "resolve-embedded"; postingId: string; pageUrl: string }
  | { type: "follow-short-link"; url: string }
  | { type: "list-board"; ats: Ats; token: string }
  | { type: "find-board"; employer: string }
  | { type: "fetch-schema"; ats: Ats; token: string; postingId: string };

export interface PendingLookup {
  readonly jobId: string;
  readonly employer: string;
  readonly title: string;
  readonly task: LookupTask;
}

export type LookupResult =
  | {
      type: "job";
      ats: Ats;
      jobId: string;
      token: string;
      postingId: string;
      url: string;
      live: boolean;
    }
  | {
      type: "board";
      ats: Ats;
      jobId: string;
      employer: string;
      token: string | null;
      method: string;
      jobs?: BoardJob[];
      details?: Record<string, string>;
    }
  | {
      type: "schema";
      ats: Ats;
      jobId: string;
      token: string;
      postingId: string;
      payload: unknown;
    };

/** What the server answers to a result (subset the extension cares about). */
export interface ResultOutcome {
  readonly status: string;
  readonly postingIds?: string[];
  readonly postingUrl?: string;
  readonly reason?: string;
}

export interface LookupDeps {
  readonly fetch: typeof fetch;
  /** Called between outside requests, to stay polite. */
  readonly pause: () => Promise<void>;
  readonly submit: (result: LookupResult) => Promise<ResultOutcome>;
}

export const BOARDS: Readonly<Record<Ats, BoardApi>> = {
  greenhouse,
  ashby,
  lever,
};
/** Systems in the order a company's board is searched for. */
const SEARCH_ORDER: readonly BoardApi[] = [greenhouse, ashby, lever];

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
  await deps.pause();
  try {
    const res = await deps.fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(employer)}`,
      { headers: { accept: "application/json" } },
    );
    const data = res.ok ? ((await res.json()) as unknown) : null;
    const first = Array.isArray(data)
      ? (data[0] as { domain?: unknown } | undefined)
      : undefined;
    return typeof first?.domain === "string" ? first.domain : null;
  } catch {
    return null;
  }
}

export async function findBoard(
  deps: LookupDeps,
  employer: string,
): Promise<{ ats: Ats; token: string; method: string } | null> {
  for (const api of SEARCH_ORDER)
    for (const token of slugGuesses(employer))
      if (await api.exists(deps, token))
        return { ats: api.ats, token, method: "name-slug" };
  // A company's own careers page can embed a Greenhouse board under another name.
  const domain = await companyDomain(deps, employer);
  if (!domain) return null;
  try {
    await deps.pause();
    const found = await resolveGreenhouseSource({
      url: `https://${domain}`,
      fetchImpl: deps.fetch,
    });
    return {
      ats: "greenhouse",
      token: found.token,
      method: `domain:${found.method}`,
    };
  } catch {
    return null;
  }
}

async function boardLookup(
  deps: LookupDeps,
  p: PendingLookup,
  board: { ats: Ats; token: string } | null,
  method: string,
) {
  if (!board) {
    await deps.submit({
      type: "board",
      ats: "greenhouse",
      jobId: p.jobId,
      employer: p.employer,
      token: null,
      method,
    });
    return "no board on a supported system";
  }
  const api = BOARDS[board.ats];
  const listing: BoardListing | null = await api.list(deps, board.token);
  if (!listing) return `${board.ats} board ${board.token} unreachable`;
  const base = {
    type: "board" as const,
    ats: board.ats,
    jobId: p.jobId,
    employer: p.employer,
    token: board.token,
    method,
    jobs: [...listing.jobs],
  };
  let outcome = await deps.submit(base);
  if (outcome.status === "need-details" && outcome.postingIds?.length) {
    outcome = await deps.submit({
      ...base,
      details: await api.describe(
        deps,
        board.token,
        outcome.postingIds,
        listing,
      ),
    });
  }
  return `${board.ats} board ${board.token}: ${outcome.status}${outcome.postingUrl ? ` ${outcome.postingUrl}` : ""}`;
}

async function verifyJob(
  deps: LookupDeps,
  jobId: string,
  ats: Ats,
  token: string,
  postingId: string,
) {
  const { live, url } = await BOARDS[ats].verify(deps, token, postingId);
  const outcome = await deps.submit({
    type: "job",
    ats,
    jobId,
    token,
    postingId,
    url,
    live,
  });
  return `posting ${outcome.status}`;
}

async function resolveEmbedded(
  deps: LookupDeps,
  jobId: string,
  pageUrl: string,
  postingId: string,
) {
  try {
    await deps.pause();
    const { token } = await resolveGreenhouseSource({
      url: pageUrl,
      fetchImpl: deps.fetch,
    });
    return verifyJob(deps, jobId, "greenhouse", token, postingId);
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
      "greenhouse",
      parseGreenhouseUrl(landed).token,
      jobMatch[1],
    );
  if (ghJid) return resolveEmbedded(deps, jobId, landed, ghJid);
  return "short link doesn't lead to a Greenhouse posting";
}

async function fetchSchema(
  deps: LookupDeps,
  jobId: string,
  ats: Ats,
  token: string,
  postingId: string,
) {
  const payload = await BOARDS[ats].form(deps, token, postingId);
  if (!payload) {
    const { url } = await BOARDS[ats].verify(deps, token, postingId);
    const outcome = await deps.submit({
      type: "job",
      ats,
      jobId,
      token,
      postingId,
      url,
      live: false,
    });
    return `form gone: posting ${outcome.status}`;
  }
  const outcome = await deps.submit({
    type: "schema",
    ats,
    jobId,
    token,
    postingId,
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
      return verifyJob(deps, p.jobId, task.ats, task.token, task.postingId);
    case "resolve-embedded":
      return resolveEmbedded(deps, p.jobId, task.pageUrl, task.postingId);
    case "follow-short-link":
      return followShortLink(deps, p.jobId, task.url);
    case "list-board":
      return boardLookup(deps, p, task, "cached");
    case "find-board": {
      const found = await findBoard(deps, task.employer);
      return boardLookup(deps, p, found, found?.method ?? "name-slug+domain");
    }
    case "fetch-schema":
      return fetchSchema(deps, p.jobId, task.ats, task.token, task.postingId);
  }
}
