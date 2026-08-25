import {
  getCountryNameVariants,
  normalizeCountryKey,
} from "@shared/location-support.js";
import type { CreateJobInput } from "@shared/types/jobs";

const REMOTEOK_API_URL = "https://remoteok.com/api";
// RemoteOK rejects requests without a browser-like User-Agent (returns 403).
const REMOTEOK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface RemoteOkProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}

export interface RunRemoteOkOptions {
  searchTerms?: string[];
  selectedCountry?: string;
  workplaceTypes?: Array<"remote" | "hybrid" | "onsite">;
  maxJobsPerTerm?: number;
  onProgress?: (event: RemoteOkProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface RemoteOkResult {
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
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

export function matchesRemoteOkSearchTerm(
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
 * RemoteOK's location field is a free-text, often-blank description of where
 * the company/role is based, not a structured country. Filtering is a soft
 * text match, and blank/unreadable locations are treated as unrestricted.
 */
export function matchesRemoteOkLocation(
  location: string | undefined,
  selectedCountry: string | undefined,
): boolean {
  const normalizedCountry = normalizeCountryKey(selectedCountry);
  if (!normalizedCountry || normalizedCountry === "worldwide") return true;

  const locationText = (location ?? "").toLowerCase();
  if (!locationText) return true;
  if (/worldwide|anywhere|global/.test(locationText)) return true;

  const variants = getCountryNameVariants(normalizedCountry);
  return variants.some((variant) =>
    locationText.includes(variant.toLowerCase()),
  );
}

export function mapRemoteOkJob(value: unknown): CreateJobInput | null {
  const row = asRecord(value);
  if (!row || "legal" in row) return null;

  const title = asString(row.position);
  const employer = asString(row.company);
  const jobUrl = asHttpUrl(row.url) ?? asHttpUrl(row.apply_url);
  if (!title || !employer || !jobUrl) return null;

  const tags = asStringList(row.tags);
  const rawId = row.id ?? row.slug;
  const sourceJobId =
    typeof rawId === "number"
      ? String(rawId)
      : typeof rawId === "string"
        ? rawId
        : undefined;
  const location = asString(row.location)?.replace(/,\s*$/, "");

  return {
    source: "remoteok",
    sourceJobId,
    title,
    employer,
    jobUrl,
    applicationLink: jobUrl,
    location: location || "Worldwide",
    jobDescription: asString(row.description),
    datePosted: asString(row.date),
    salaryMinAmount: asNumber(row.salary_min),
    salaryMaxAmount: asNumber(row.salary_max),
    skills: tags.length > 0 ? tags.join(", ") : undefined,
    companyLogo: asHttpUrl(row.company_logo) ?? asHttpUrl(row.logo),
    isRemote: true,
  };
}

function matchesWorkplaceTypes(
  workplaceTypes: Array<"remote" | "hybrid" | "onsite"> | undefined,
): boolean {
  if (!workplaceTypes || workplaceTypes.length === 0) return true;
  return workplaceTypes.includes("remote");
}

async function fetchRemoteOkJobs(
  fetchImpl: typeof fetch,
): Promise<CreateJobInput[]> {
  const response = await fetchImpl(REMOTEOK_API_URL, {
    headers: { Accept: "application/json", "User-Agent": REMOTEOK_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`RemoteOK request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("RemoteOK returned an invalid jobs response");
  }

  return payload
    .map(mapRemoteOkJob)
    .filter((job): job is CreateJobInput => Boolean(job));
}

export async function runRemoteOk(
  options: RunRemoteOkOptions = {},
): Promise<RemoteOkResult> {
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
    // RemoteOK has no server-side search; fetch the feed once and filter it
    // client-side per term to avoid hammering the API on every term.
    const allJobs = await fetchRemoteOkJobs(fetchImpl);

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
      for (const job of allJobs) {
        if (jobsFoundTerm >= maxJobsPerTerm) break;
        if (seenUrls.has(job.jobUrl)) continue;
        if (!matchesRemoteOkSearchTerm(job, searchTerm)) continue;
        if (!matchesRemoteOkLocation(job.location, options.selectedCountry)) {
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
          : "Unexpected error while running RemoteOK extractor",
    };
  }
}
