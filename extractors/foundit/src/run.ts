import {
  durationFits,
  findDurationInText,
  formatDuration,
  type MonthRange,
} from "@shared/internship-duration.js";
import {
  isInternshipTitle,
  toInternshipKeywords,
} from "@shared/internship-search.js";
import type { CreateJobInput, JobLocationEvidence } from "@shared/types/jobs";

const ORIGIN = "https://www.foundit.in";
const SEARCH_URL = `${ORIGIN}/middleware/jobsearch`;
const DETAIL_URL = `${ORIGIN}/middleware/jobdetail`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
/** Results come newest first; one page covers a day's internships per keyword. */
const PAGE_SIZE = 50;
/** Detail pages opened per run for the full description. */
const MAX_DETAILS_PER_RUN = 30;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 1_000;

type UnknownRecord = Record<string, unknown>;

export interface FounditProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  location?: string;
  jobsFoundTerm?: number;
}

export interface RunFounditOptions {
  searchTerms?: string[];
  /** Cities to search; empty searches all of India. */
  cities?: string[];
  /** Lengths wanted; null means any length. */
  duration?: MonthRange | null;
  maxJobsPerTerm?: number;
  /** Jobs already stored: kept, but their details aren't fetched again. */
  existingJobUrls?: readonly string[];
  shouldCancel?: () => boolean;
  onProgress?: (event: FounditProgressEvent) => void;
  fetchImpl?: typeof fetch;
  delayMs?: number;
}

export interface FounditResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
  /** Searches that failed while others succeeded. */
  errors?: string[];
}

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

function asHttpUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function titleCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

/** Foundit needs "intern" in the query to return internships. */
export function toFounditQueries(terms: readonly string[]): string[] {
  return toInternshipKeywords(terms).map((keyword) => `${keyword} intern`);
}

export function buildFounditSearchUrl(
  query: string,
  city?: string | null,
): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("start", "0");
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("query", query);
  if (city?.trim()) url.searchParams.set("locations", titleCase(city));
  return url.toString();
}

/** "Mumbai, India", ["Mumbai", "Thane"] or [{ city: "Mumbai" }] → place names. */
function readLocations(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && part.toLowerCase() !== "india");
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asString(item) ?? asString(asRecord(item)?.city))
    .filter((item): item is string => Boolean(item));
}

function stipendOf(row: UnknownRecord): string | undefined {
  const min = asNumber(asRecord(row.minimumSalary)?.absoluteMonthlyValue);
  const max = asNumber(asRecord(row.maximumSalary)?.absoluteMonthlyValue);
  if (!max || max <= 0 || row.hideSalary === 1) return undefined;
  const format = (amount: number) =>
    `₹${Math.round(amount).toLocaleString("en-IN")}`;
  return min && min > 0 && min !== max
    ? `${format(min)} - ${format(max)} /month`
    : `${format(max)} /month`;
}

function toLocation(places: string[]): {
  location: string;
  isRemote: boolean;
  locationEvidence: JobLocationEvidence;
} {
  const onsite = places.filter(
    (place) => !/remote|work from home/i.test(place),
  );
  const isRemote = places.length > 0 && onsite.length === 0;
  const label = isRemote
    ? "Remote, India"
    : onsite.length > 0
      ? `${onsite.join(", ")}, India`
      : "India";
  return {
    location: label,
    isRemote,
    locationEvidence: {
      rawLocation: places.join(", ") || null,
      location: label,
      countryKey: "india",
      country: "india",
      isRemote,
      evidenceQuality: places.length > 0 ? "approximate" : "weak",
      source: "foundit",
      sourceNotes: ["Searched on foundit.in (India)."],
    },
  };
}

export interface FounditListing {
  jobId: string;
  job: CreateJobInput;
}

/** Maps a search result; non-internship titles are dropped. */
export function mapFounditListing(value: unknown): FounditListing | null {
  const row = asRecord(value);
  const title = asString(row?.title);
  const employer = asString(row?.companyName);
  const jobId = row?.jobId ?? row?.id;
  const path = asString(row?.seoJdUrl) ?? asString(row?.jdUrl);
  if (!row || !title || !employer || jobId === undefined || !path) return null;
  if (!isInternshipTitle(title) || row.hideCompanyName === 1) return null;

  const jobUrl = new URL(path, ORIGIN).toString();
  const place = toLocation(readLocations(row.locations));
  const createdAt = asNumber(row.createdAt);
  const skills = asString(row.skills);

  return {
    jobId: String(jobId),
    job: {
      source: "foundit",
      sourceJobId: String(jobId),
      title,
      employer,
      jobUrl,
      applicationLink:
        asHttpUrl(row.applyUrl) ?? asHttpUrl(row.redirectUrl) ?? jobUrl,
      location: place.location,
      locationEvidence: place.locationEvidence,
      isRemote: place.isRemote,
      salary: stipendOf(row),
      jobType: "Internship",
      datePosted: createdAt ? new Date(createdAt).toISOString() : undefined,
      skills,
    },
  };
}

/** Adds the detail's description and the stated length to a listing's job. */
export function withFounditDetail(
  job: CreateJobInput,
  description: string | undefined,
): { job: CreateJobInput; duration: MonthRange | null } {
  const duration = findDurationInText(`${job.title}. ${description ?? ""}`);
  const durationLabel = duration ? formatDuration(duration) : undefined;
  const header = [
    durationLabel ? `Duration: ${durationLabel}` : null,
    job.salary ? `Stipend: ${job.salary}` : null,
    `Location: ${job.location}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    duration,
    job: {
      ...job,
      jobType: durationLabel ? `Internship · ${durationLabel}` : job.jobType,
      jobDescription: description ? `${header}\n\n${description}` : undefined,
    },
  };
}

const sleep = (ms: number) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Referer: `${ORIGIN}/`,
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Foundit request failed with status ${response.status}`);
  }
  return response.json();
}

async function fetchSearchRows(
  fetchImpl: typeof fetch,
  query: string,
  city: string | null,
): Promise<unknown[]> {
  const payload = asRecord(
    await fetchJson(fetchImpl, buildFounditSearchUrl(query, city)),
  );
  const rows = asRecord(payload?.jobSearchResponse)?.data;
  if (!Array.isArray(rows)) {
    throw new Error("Foundit returned an invalid search response");
  }
  return rows;
}

async function fetchDescription(
  fetchImpl: typeof fetch,
  jobId: string,
): Promise<string | undefined> {
  const payload = asRecord(
    await fetchJson(fetchImpl, `${DETAIL_URL}/${encodeURIComponent(jobId)}`),
  );
  return asString(asRecord(payload?.jobDetailResponse)?.description);
}

export async function runFoundit(
  options: RunFounditOptions = {},
): Promise<FounditResult> {
  const queries = toFounditQueries(
    options.searchTerms?.length ? options.searchTerms : ["marketing"],
  );
  const cities: Array<string | null> = options.cities?.length
    ? options.cities
    : [null];
  const duration = options.duration ?? null;
  const maxJobsPerTerm = Math.max(1, Math.floor(options.maxJobsPerTerm ?? 20));
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayMs = options.delayMs ?? REQUEST_DELAY_MS;
  const existing = new Set(options.existingJobUrls ?? []);
  const listings = new Map<string, FounditListing>();
  const errors: string[] = [];
  const searches = queries.flatMap((query) =>
    cities.map((city) => ({ query, city })),
  );

  for (const [index, search] of searches.entries()) {
    if (options.shouldCancel?.()) break;
    const termIndex = index + 1;
    const location = search.city ?? undefined;
    options.onProgress?.({
      type: "term_start",
      termIndex,
      termTotal: searches.length,
      searchTerm: search.query,
      location,
    });

    let jobsFoundTerm = 0;
    try {
      if (index > 0) await sleep(delayMs);
      for (const row of await fetchSearchRows(
        fetchImpl,
        search.query,
        search.city,
      )) {
        if (jobsFoundTerm >= maxJobsPerTerm) break;
        const listing = mapFounditListing(row);
        if (!listing || listings.has(listing.job.jobUrl)) continue;
        listings.set(listing.job.jobUrl, listing);
        jobsFoundTerm += 1;
      }
    } catch (error) {
      errors.push(
        `${search.query}${location ? ` in ${location}` : ""}: ${
          error instanceof Error ? error.message : "unexpected error"
        }`,
      );
    }

    options.onProgress?.({
      type: "term_complete",
      termIndex,
      termTotal: searches.length,
      searchTerm: search.query,
      location,
      jobsFoundTerm,
    });
  }

  if (listings.size === 0 && errors.length > 0) {
    return { success: false, jobs: [], error: errors.join("; ") };
  }

  const jobs: CreateJobInput[] = [];
  let detailsOpened = 0;
  for (const listing of listings.values()) {
    let description: string | undefined;
    const shouldFetch =
      !existing.has(listing.job.jobUrl) &&
      detailsOpened < MAX_DETAILS_PER_RUN &&
      !options.shouldCancel?.();
    if (shouldFetch) {
      detailsOpened += 1;
      await sleep(delayMs);
      try {
        description = await fetchDescription(fetchImpl, listing.jobId);
      } catch {
        // Keep the listing without a description when the detail call fails.
        description = undefined;
      }
    }
    const detailed = withFounditDetail(listing.job, description);
    if (!durationFits(detailed.duration, duration)) continue;
    jobs.push(detailed.job);
  }

  return errors.length > 0
    ? { success: true, jobs, errors }
    : { success: true, jobs };
}
