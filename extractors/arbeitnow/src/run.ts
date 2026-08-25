import type { CreateJobInput } from "@shared/types/jobs";

const ARBEITNOW_API_URL = "https://www.arbeitnow.com/api/job-board-api";
// Arbeitnow has no server-side search or remote filter and asks integrators
// not to abuse the feed, so a run only walks a bounded number of pages.
const MAX_PAGES_PER_RUN = 3;

export interface ArbeitnowProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}

export interface RunArbeitnowOptions {
  searchTerms?: string[];
  workplaceTypes?: Array<"remote" | "hybrid" | "onsite">;
  maxJobsPerTerm?: number;
  onProgress?: (event: ArbeitnowProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface ArbeitnowResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((item): item is string => Boolean(item))
    : [];
}

function asHttpUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesArbeitnowSearchTerm(
  job: { title: string; jobDescription?: string; skills?: string },
  searchTerm: string,
): boolean {
  const normalizedTerm = normalizeForMatch(searchTerm);
  if (!normalizedTerm) return true;

  const haystack = normalizeForMatch(
    [job.title, job.jobDescription, job.skills].filter(Boolean).join(" "),
  );
  if (!haystack) return false;
  if (haystack.includes(normalizedTerm)) return true;

  return normalizedTerm
    .split(" ")
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

/**
 * Only jobs marked `remote: true` are surfaced — Arbeitnow's `location` field
 * reflects the listing company's home base, not the remote-work eligibility
 * region, so it isn't reliable for country filtering and is left unfiltered.
 */
export function mapArbeitnowJob(value: unknown): CreateJobInput | null {
  const row = asRecord(value);
  if (!row || row.remote !== true) return null;

  const title = asString(row.title);
  const employer = asString(row.company_name);
  const jobUrl = asHttpUrl(row.url);
  if (!title || !employer || !jobUrl) return null;

  const tags = asStringList(row.tags);
  const jobTypes = asStringList(row.job_types);
  const createdAt = row.created_at;
  const createdAtSeconds =
    typeof createdAt === "number" && Number.isFinite(createdAt)
      ? createdAt
      : undefined;

  return {
    source: "arbeitnow",
    sourceJobId: asString(row.slug),
    title,
    employer,
    jobUrl,
    applicationLink: jobUrl,
    location: asString(row.location) ?? "Remote",
    jobDescription: asString(row.description),
    datePosted:
      createdAtSeconds !== undefined
        ? new Date(createdAtSeconds * 1000).toISOString()
        : undefined,
    jobType: jobTypes.length > 0 ? jobTypes.join(", ") : undefined,
    skills: tags.length > 0 ? tags.join(", ") : undefined,
    isRemote: true,
  };
}

function matchesWorkplaceTypes(
  workplaceTypes: Array<"remote" | "hybrid" | "onsite"> | undefined,
): boolean {
  if (!workplaceTypes || workplaceTypes.length === 0) return true;
  return workplaceTypes.includes("remote");
}

async function fetchArbeitnowRemoteJobs(
  fetchImpl: typeof fetch,
  shouldCancel: (() => boolean) | undefined,
): Promise<CreateJobInput[]> {
  const jobs: CreateJobInput[] = [];

  for (let page = 1; page <= MAX_PAGES_PER_RUN; page += 1) {
    if (shouldCancel?.()) break;

    const url = new URL(ARBEITNOW_API_URL);
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(
        `Arbeitnow request failed with status ${response.status}`,
      );
    }

    const payload = asRecord((await response.json()) as unknown);
    if (!Array.isArray(payload?.data)) {
      throw new Error("Arbeitnow returned an invalid jobs response");
    }

    for (const value of payload.data) {
      const job = mapArbeitnowJob(value);
      if (job) jobs.push(job);
    }

    const nextLink = asRecord(payload.links)?.next;
    if (!nextLink) break;
  }

  return jobs;
}

export async function runArbeitnow(
  options: RunArbeitnowOptions = {},
): Promise<ArbeitnowResult> {
  const searchTerms = options.searchTerms?.length
    ? options.searchTerms
    : ["software engineer"];
  const maxJobsPerTerm = Number.isFinite(options.maxJobsPerTerm)
    ? Math.max(1, Math.floor(options.maxJobsPerTerm as number))
    : 50;
  const fetchImpl = options.fetchImpl ?? fetch;
  const jobs: CreateJobInput[] = [];
  const seenUrls = new Set<string>();

  if (!matchesWorkplaceTypes(options.workplaceTypes)) {
    return { success: true, jobs: [] };
  }

  try {
    const remoteJobs = await fetchArbeitnowRemoteJobs(
      fetchImpl,
      options.shouldCancel,
    );

    for (const [index, searchTerm] of searchTerms.entries()) {
      if (options.shouldCancel?.()) return { success: true, jobs };

      const termIndex = index + 1;
      options.onProgress?.({
        type: "term_start",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
      });

      let jobsFoundTerm = 0;
      for (const job of remoteJobs) {
        if (jobsFoundTerm >= maxJobsPerTerm) break;
        if (seenUrls.has(job.jobUrl)) continue;
        if (!matchesArbeitnowSearchTerm(job, searchTerm)) continue;

        seenUrls.add(job.jobUrl);
        jobs.push(job);
        jobsFoundTerm += 1;
      }

      options.onProgress?.({
        type: "term_complete",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
        jobsFoundTerm,
      });
    }

    return { success: true, jobs };
  } catch (error) {
    return {
      success: false,
      jobs: [],
      error:
        error instanceof Error
          ? error.message
          : "Unexpected error while running Arbeitnow extractor",
    };
  }
}
