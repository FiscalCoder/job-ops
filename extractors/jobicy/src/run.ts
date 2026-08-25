import {
  getCountryNameVariants,
  normalizeCountryKey,
} from "@shared/location-support.js";
import type { CreateJobInput } from "@shared/types/jobs";

const JOBICY_SEARCH_URL = "https://jobicy.com/api/v2/remote-jobs";

export interface JobicyProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}

export interface RunJobicyOptions {
  searchTerms?: string[];
  selectedCountry?: string;
  workplaceTypes?: Array<"remote" | "hybrid" | "onsite">;
  maxJobsPerTerm?: number;
  onProgress?: (event: JobicyProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface JobicyResult {
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
  return typeof value === "number" && Number.isFinite(value)
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

function formatSalary(row: UnknownRecord): string | undefined {
  const minimum = asNumber(row.salaryMin);
  const maximum = asNumber(row.salaryMax);
  if (minimum === undefined && maximum === undefined) return undefined;

  const format = (value: number) =>
    new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
  const amount =
    minimum !== undefined && maximum !== undefined
      ? `${format(minimum)}–${format(maximum)}`
      : minimum !== undefined
        ? `from ${format(minimum)}`
        : `up to ${format(maximum as number)}`;
  const currency = asString(row.salaryCurrency);
  const period = asString(row.salaryPeriod);

  return `${currency ? `${currency} ` : ""}${amount}${period ? `/${period}` : ""}`;
}

/**
 * Jobicy's ?geo= filter only accepts a small, undocumented set of exact
 * "geoSlug" values and hard-errors on anything else, so filtering is done
 * client-side against the free-text jobGeo field instead.
 */
export function matchesJobicyLocation(
  jobGeo: string | undefined,
  selectedCountry: string | undefined,
): boolean {
  const normalizedCountry = normalizeCountryKey(selectedCountry);
  if (!normalizedCountry || normalizedCountry === "worldwide") return true;

  const location = (jobGeo ?? "").toLowerCase();
  if (!location) return true;
  if (/worldwide|anywhere|global/.test(location)) return true;

  const variants = getCountryNameVariants(normalizedCountry);
  return variants.some((variant) => location.includes(variant.toLowerCase()));
}

export function mapJobicyJob(value: unknown): CreateJobInput | null {
  const row = asRecord(value);
  const title = asString(row?.jobTitle);
  const employer = asString(row?.companyName);
  const jobUrl = asHttpUrl(row?.url);
  if (!row || !title || !employer || !jobUrl) return null;

  const jobIndustry = asStringList(row.jobIndustry);
  const jobType = asStringList(row.jobType);
  const rawId = row.id;
  const sourceJobId =
    typeof rawId === "number"
      ? String(rawId)
      : typeof rawId === "string"
        ? rawId
        : undefined;

  return {
    source: "jobicy",
    sourceJobId,
    title,
    employer,
    jobUrl,
    applicationLink: jobUrl,
    location: asString(row.jobGeo) ?? "Worldwide",
    jobDescription: asString(row.jobDescription) ?? asString(row.jobExcerpt),
    datePosted: asString(row.pubDate),
    salary: formatSalary(row),
    salaryInterval: asString(row.salaryPeriod),
    salaryMinAmount: asNumber(row.salaryMin),
    salaryMaxAmount: asNumber(row.salaryMax),
    salaryCurrency: asString(row.salaryCurrency),
    jobType: jobType.length > 0 ? jobType.join(", ") : undefined,
    jobLevel: asString(row.jobLevel),
    jobFunction: jobIndustry.length > 0 ? jobIndustry.join(", ") : undefined,
    companyLogo: asHttpUrl(row.companyLogo),
    isRemote: true,
  };
}

function matchesWorkplaceTypes(
  workplaceTypes: Array<"remote" | "hybrid" | "onsite"> | undefined,
): boolean {
  if (!workplaceTypes || workplaceTypes.length === 0) return true;
  return workplaceTypes.includes("remote");
}

export function buildJobicySearchUrl(args: {
  searchTerm: string;
  count: number;
}): URL {
  const url = new URL(JOBICY_SEARCH_URL);
  if (args.searchTerm.trim())
    url.searchParams.set("tag", args.searchTerm.trim());
  url.searchParams.set("count", String(Math.min(50, Math.max(1, args.count))));
  return url;
}

export async function runJobicy(
  options: RunJobicyOptions = {},
): Promise<JobicyResult> {
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

      const url = buildJobicySearchUrl({ searchTerm, count: maxJobsPerTerm });
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`Jobicy request failed with status ${response.status}`);
      }

      const payload = asRecord((await response.json()) as unknown);
      if (payload?.success === false) {
        throw new Error(
          asString(payload.error) ?? "Jobicy returned an error response",
        );
      }
      if (!Array.isArray(payload?.jobs)) {
        throw new Error("Jobicy returned an invalid jobs response");
      }

      let jobsFoundTerm = 0;
      for (const value of payload.jobs) {
        if (jobsFoundTerm >= maxJobsPerTerm) break;

        const job = mapJobicyJob(value);
        if (!job || seenUrls.has(job.jobUrl)) continue;
        if (!matchesJobicyLocation(job.location, options.selectedCountry)) {
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
          : "Unexpected error while running Jobicy extractor",
    };
  }
}
