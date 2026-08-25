import {
  getCountryNameVariants,
  normalizeCountryKey,
} from "@shared/location-support.js";
import type { CreateJobInput } from "@shared/types/jobs";

const HIMALAYAS_SEARCH_URL = "https://himalayas.app/jobs/api";

export interface HimalayasProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}

export interface RunHimalayasOptions {
  searchTerms?: string[];
  selectedCountry?: string;
  workplaceTypes?: Array<"remote" | "hybrid" | "onsite">;
  maxJobsPerTerm?: number;
  onProgress?: (event: HimalayasProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface HimalayasResult {
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
  const minimum = asNumber(row.minSalary);
  const maximum = asNumber(row.maxSalary);
  if (minimum === undefined && maximum === undefined) return undefined;

  const format = (value: number) =>
    new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
  const amount =
    minimum !== undefined && maximum !== undefined
      ? `${format(minimum)}–${format(maximum)}`
      : minimum !== undefined
        ? `from ${format(minimum)}`
        : `up to ${format(maximum as number)}`;
  const currency = asString(row.currency);
  const period = asString(row.salaryPeriod);

  return `${currency ? `${currency} ` : ""}${amount}${period ? `/${period}` : ""}`;
}

function sourceJobIdFromUrl(url: string): string | undefined {
  const segments = url.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

/**
 * Himalayas' locationRestrictions is a free-text country/region list (often
 * empty, meaning fully worldwide-open), so filtering is a soft text match
 * rather than an exact lookup.
 */
export function matchesHimalayasLocation(
  locationRestrictions: string[],
  selectedCountry: string | undefined,
): boolean {
  const normalizedCountry = normalizeCountryKey(selectedCountry);
  if (!normalizedCountry || normalizedCountry === "worldwide") return true;
  if (locationRestrictions.length === 0) return true;

  const variants = getCountryNameVariants(normalizedCountry).map((variant) =>
    variant.toLowerCase(),
  );
  return locationRestrictions.some((restriction) => {
    const lowered = restriction.toLowerCase();
    return variants.some((variant) => lowered.includes(variant));
  });
}

export function mapHimalayasJob(value: unknown): CreateJobInput | null {
  const row = asRecord(value);
  const title = asString(row?.title);
  const employer = asString(row?.companyName);
  const jobUrl = asHttpUrl(row?.applicationLink) ?? asHttpUrl(row?.guid);
  if (!row || !title || !employer || !jobUrl) return null;

  const categories = asStringList(row.categories);
  const parentCategories = asStringList(row.parentCategories);
  const seniority = asStringList(row.seniority);
  const locationRestrictions = asStringList(row.locationRestrictions);
  const pubDateSeconds = asNumber(row.pubDate);

  return {
    source: "himalayas",
    sourceJobId: sourceJobIdFromUrl(jobUrl),
    title,
    employer,
    jobUrl,
    applicationLink: jobUrl,
    location:
      locationRestrictions.length > 0
        ? locationRestrictions.join(", ")
        : "Worldwide",
    jobDescription: asString(row.description) ?? asString(row.excerpt),
    datePosted:
      pubDateSeconds !== undefined
        ? new Date(pubDateSeconds * 1000).toISOString()
        : undefined,
    salary: formatSalary(row),
    salaryInterval: asString(row.salaryPeriod),
    salaryMinAmount: asNumber(row.minSalary),
    salaryMaxAmount: asNumber(row.maxSalary),
    salaryCurrency: asString(row.currency),
    jobType: asString(row.employmentType),
    jobLevel: seniority[0],
    jobFunction:
      parentCategories.length > 0 ? parentCategories.join(", ") : categories[0],
    skills: categories.length > 0 ? categories.join(", ") : undefined,
    isRemote: true,
  };
}

function matchesWorkplaceTypes(
  workplaceTypes: Array<"remote" | "hybrid" | "onsite"> | undefined,
): boolean {
  if (!workplaceTypes || workplaceTypes.length === 0) return true;
  return workplaceTypes.includes("remote");
}

export function buildHimalayasSearchUrl(args: {
  searchTerm: string;
  limit: number;
}): URL {
  const url = new URL(HIMALAYAS_SEARCH_URL);
  if (args.searchTerm.trim())
    url.searchParams.set("search", args.searchTerm.trim());
  url.searchParams.set("limit", String(Math.min(100, Math.max(1, args.limit))));
  return url;
}

export async function runHimalayas(
  options: RunHimalayasOptions = {},
): Promise<HimalayasResult> {
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

      const url = buildHimalayasSearchUrl({
        searchTerm,
        limit: maxJobsPerTerm,
      });
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(
          `Himalayas request failed with status ${response.status}`,
        );
      }

      const payload = asRecord((await response.json()) as unknown);
      if (!Array.isArray(payload?.jobs)) {
        throw new Error("Himalayas returned an invalid jobs response");
      }

      let jobsFoundTerm = 0;
      for (const value of payload.jobs) {
        if (jobsFoundTerm >= maxJobsPerTerm) break;

        const job = mapHimalayasJob(value);
        if (!job || seenUrls.has(job.jobUrl)) continue;
        const record = asRecord(value);
        const locationRestrictions = asStringList(record?.locationRestrictions);
        if (
          !matchesHimalayasLocation(
            locationRestrictions,
            options.selectedCountry,
          )
        ) {
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
          : "Unexpected error while running Himalayas extractor",
    };
  }
}
