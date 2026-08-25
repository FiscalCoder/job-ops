import {
  getCountryNameVariants,
  normalizeCountryKey,
} from "@shared/location-support.js";
import type { CreateJobInput } from "@shared/types/jobs";

const REMOTIVE_SEARCH_URL = "https://remotive.com/api/remote-jobs";

export interface RemotiveProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}

export interface RunRemotiveOptions {
  searchTerms?: string[];
  selectedCountry?: string;
  workplaceTypes?: Array<"remote" | "hybrid" | "onsite">;
  maxJobsPerTerm?: number;
  onProgress?: (event: RemotiveProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface RemotiveResult {
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

/**
 * Remotive locations are free-text region labels (e.g. "USA Only", "Europe",
 * "Worldwide") rather than structured country codes, so filtering is a soft
 * text match rather than an exact lookup.
 */
export function matchesRemotiveLocation(
  candidateRequiredLocation: string | undefined,
  selectedCountry: string | undefined,
): boolean {
  const normalizedCountry = normalizeCountryKey(selectedCountry);
  if (!normalizedCountry || normalizedCountry === "worldwide") return true;

  const location = (candidateRequiredLocation ?? "").toLowerCase();
  if (!location) return true;
  if (/worldwide|anywhere|global/.test(location)) return true;

  const variants = getCountryNameVariants(normalizedCountry);
  return variants.some((variant) => location.includes(variant.toLowerCase()));
}

export function mapRemotiveJob(value: unknown): CreateJobInput | null {
  const row = asRecord(value);
  const title = asString(row?.title);
  const employer = asString(row?.company_name);
  const jobUrl = asHttpUrl(row?.url);
  if (!row || !title || !employer || !jobUrl) return null;

  const tags = asStringList(row.tags);
  const rawId = row.id;
  const sourceJobId =
    typeof rawId === "number"
      ? String(rawId)
      : typeof rawId === "string"
        ? rawId
        : undefined;

  return {
    source: "remotive",
    sourceJobId,
    title,
    employer,
    jobUrl,
    applicationLink: jobUrl,
    location: asString(row.candidate_required_location) ?? "Worldwide",
    jobDescription: asString(row.description),
    datePosted: asString(row.publication_date),
    salary: asString(row.salary),
    jobType: asString(row.job_type),
    jobFunction: asString(row.category),
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

export function buildRemotiveSearchUrl(searchTerm: string): URL {
  const url = new URL(REMOTIVE_SEARCH_URL);
  if (searchTerm.trim()) url.searchParams.set("search", searchTerm.trim());
  return url;
}

export async function runRemotive(
  options: RunRemotiveOptions = {},
): Promise<RemotiveResult> {
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
    for (const [index, searchTerm] of searchTerms.entries()) {
      if (options.shouldCancel?.()) return { success: true, jobs };

      const termIndex = index + 1;
      options.onProgress?.({
        type: "term_start",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
      });

      const response = await fetchImpl(buildRemotiveSearchUrl(searchTerm), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(
          `Remotive request failed with status ${response.status}`,
        );
      }

      const payload = asRecord((await response.json()) as unknown);
      if (!Array.isArray(payload?.jobs)) {
        throw new Error("Remotive returned an invalid jobs response");
      }

      let jobsFoundTerm = 0;
      for (const value of payload.jobs) {
        if (jobsFoundTerm >= maxJobsPerTerm) break;

        const job = mapRemotiveJob(value);
        if (!job || seenUrls.has(job.jobUrl)) continue;
        if (!matchesRemotiveLocation(job.location, options.selectedCountry)) {
          continue;
        }

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
          : "Unexpected error while running Remotive extractor",
    };
  }
}
