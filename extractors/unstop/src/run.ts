import {
  durationFits,
  findDurationInText,
  formatDuration,
  type MonthRange,
} from "@shared/internship-duration.js";
import { toInternshipKeywords } from "@shared/internship-search.js";
import { matchesRequestedCity } from "@shared/search-cities.js";
import type { CreateJobInput, JobLocationEvidence } from "@shared/types/jobs";

const ORIGIN = "https://unstop.com";
const SEARCH_URL = `${ORIGIN}/api/public/opportunity/search-result`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PER_PAGE = 30;
/** Results aren't sorted by date or city, so a keyword's few pages are all read. */
const MAX_PAGES_PER_KEYWORD = 4;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 1_000;

type WorkplaceType = "remote" | "hybrid" | "onsite";
type UnknownRecord = Record<string, unknown>;

export interface UnstopProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}

export interface RunUnstopOptions {
  searchTerms?: string[];
  /** Cities to keep; empty keeps every location. */
  cities?: string[];
  workplaceTypes?: WorkplaceType[];
  /**
   * Keep remote listings. False when the search is limited to the selected
   * cities, since the pipeline would drop remote listings there anyway.
   */
  includeRemote?: boolean;
  /** Lengths wanted; null means any length. */
  duration?: MonthRange | null;
  maxJobsPerTerm?: number;
  shouldCancel?: () => boolean;
  onProgress?: (event: UnstopProgressEvent) => void;
  fetchImpl?: typeof fetch;
  delayMs?: number;
}

export interface UnstopResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
  /** Keywords that failed while others succeeded. */
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
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : undefined;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((item): item is string => Boolean(item))
    : [];
}

export function buildUnstopSearchUrl(keyword: string, page = 1): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("opportunity", "internships");
  url.searchParams.set("oppstatus", "open");
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("searchTerm", keyword.trim());
  url.searchParams.set("page", String(page));
  return url.toString();
}

/** "2026-11-14 11:07:01 GMT+0530" → "2026-11-14T11:07:01+05:30". */
export function toIsoDate(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(?:GMT)?([+-])(\d{2}):?(\d{2})$/.exec(
      raw,
    );
  if (match) {
    return `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`;
  }
  return Number.isNaN(new Date(raw).getTime()) ? undefined : raw;
}

function workplaceOf(detail: UnknownRecord | null): WorkplaceType {
  const type = asString(detail?.type)?.toLowerCase();
  if (type === "wfh" || type === "remote") return "remote";
  if (type === "hybrid") return "hybrid";
  return "onsite";
}

function stipendOf(detail: UnknownRecord | null): string | undefined {
  if (!detail) return undefined;
  if (asString(detail.paid_unpaid)?.toLowerCase() === "unpaid") return "Unpaid";
  if (asNumber(detail.show_salary) !== 1 || detail.not_disclosed === true) {
    return undefined;
  }
  const min = asNumber(detail.min_salary);
  const max = asNumber(detail.max_salary);
  if (min === undefined && max === undefined) return undefined;
  const format = (amount: number) => `₹${amount.toLocaleString("en-IN")}`;
  const span =
    min !== undefined && max !== undefined && min !== max
      ? `${format(min)} - ${format(max)}`
      : format((max ?? min) as number);
  const per = asString(detail.pay_in)?.toLowerCase();
  return per ? `${span} /${per.replace(/ly$/, "")}` : span;
}

function toLocation(
  locations: string[],
  workplace: WorkplaceType,
): { location: string; locationEvidence: JobLocationEvidence } {
  const label =
    workplace === "remote"
      ? "Remote, India"
      : locations.length > 0
        ? `${locations.join(", ")}${workplace === "hybrid" ? " (Hybrid)" : ""}, India`
        : "India";
  return {
    location: label,
    locationEvidence: {
      rawLocation: locations.join(", ") || null,
      location: label,
      countryKey: "india",
      country: "india",
      workplaceType: workplace,
      isRemote: workplace === "remote",
      isHybrid: workplace === "hybrid",
      evidenceQuality: locations.length > 0 ? "approximate" : "weak",
      source: "unstop",
      sourceNotes: ["Unstop lists internships in India."],
    },
  };
}

export interface UnstopListing {
  job: CreateJobInput;
  locations: string[];
  workplace: WorkplaceType;
  duration: MonthRange | null;
}

export function mapUnstopListing(value: unknown): UnstopListing | null {
  const row = asRecord(value);
  const title = asString(row?.title);
  const employer = asString(asRecord(row?.organisation)?.name);
  const path = asString(row?.public_url);
  if (!row || !title || !employer || !path) return null;

  const detail = asRecord(row.jobDetail);
  const locations = asStringList(detail?.locations);
  const workplace = workplaceOf(detail);
  const description = asString(row.details);
  const duration = findDurationInText(`${title}. ${description ?? ""}`);
  const durationLabel = duration ? formatDuration(duration) : undefined;
  const stipend = stipendOf(detail);
  const timing = asString(detail?.timing)?.replace(/_/g, "-");
  const skills = Array.isArray(row.required_skills)
    ? row.required_skills
        .map((skill) =>
          asString(asRecord(skill)?.skill_name ?? asRecord(skill)?.skill),
        )
        .filter((skill): skill is string => Boolean(skill))
    : [];
  const place = toLocation(locations, workplace);
  const jobUrl = new URL(path, `${ORIGIN}/`).toString();
  const header = [
    durationLabel ? `Duration: ${durationLabel}` : null,
    stipend ? `Stipend: ${stipend}` : null,
    timing ? `Timing: ${timing}` : null,
    `Location: ${place.location}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    locations,
    workplace,
    duration,
    job: {
      source: "unstop",
      sourceJobId: row.id === undefined ? undefined : String(row.id),
      title,
      employer,
      jobUrl,
      applicationLink: jobUrl,
      location: place.location,
      locationEvidence: place.locationEvidence,
      isRemote: workplace === "remote",
      salary: stipend,
      jobType: durationLabel ? `Internship · ${durationLabel}` : "Internship",
      datePosted: toIsoDate(row.approved_date) ?? toIsoDate(row.updated_at),
      deadline: asString(row.end_date),
      skills: skills.length > 0 ? skills.join(", ") : undefined,
      jobDescription: description ? `${header}\n\n${description}` : header,
    },
  };
}

/** Keeps listings in a wanted city, or remote ones when remote work is wanted. */
export function matchesUnstopLocation(
  listing: Pick<UnstopListing, "locations" | "workplace">,
  cities: readonly string[],
  workplaceTypes: readonly WorkplaceType[] | undefined,
  includeRemote = true,
): boolean {
  const wanted =
    workplaceTypes && workplaceTypes.length > 0
      ? workplaceTypes
      : (["remote", "hybrid", "onsite"] as const);
  if (!wanted.includes(listing.workplace)) return false;
  if (listing.workplace === "remote") return includeRemote;
  if (cities.length === 0) return true;
  return listing.locations.some((location) =>
    cities.some((city) => matchesRequestedCity(location, city)),
  );
}

const sleep = (ms: number) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

interface SearchPage {
  rows: unknown[];
  lastPage: number;
}

async function fetchSearchPage(
  fetchImpl: typeof fetch,
  keyword: string,
  page: number,
): Promise<SearchPage> {
  const response = await fetchImpl(buildUnstopSearchUrl(keyword, page), {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Unstop request failed with status ${response.status}`);
  }
  const payload = asRecord(asRecord((await response.json()) as unknown)?.data);
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Unstop returned an invalid search response");
  }
  return { rows: payload.data, lastPage: asNumber(payload.last_page) ?? page };
}

export async function runUnstop(
  options: RunUnstopOptions = {},
): Promise<UnstopResult> {
  const keywords = toInternshipKeywords(
    options.searchTerms?.length ? options.searchTerms : ["marketing"],
  );
  const cities = options.cities ?? [];
  const duration = options.duration ?? null;
  const maxJobsPerTerm = Math.max(1, Math.floor(options.maxJobsPerTerm ?? 20));
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayMs = options.delayMs ?? REQUEST_DELAY_MS;
  const jobs: CreateJobInput[] = [];
  const seenUrls = new Set<string>();
  const errors: string[] = [];

  for (const [index, keyword] of keywords.entries()) {
    if (options.shouldCancel?.()) break;
    const termIndex = index + 1;
    options.onProgress?.({
      type: "term_start",
      termIndex,
      termTotal: keywords.length,
      searchTerm: keyword,
    });

    let jobsFoundTerm = 0;
    try {
      for (let page = 1; page <= MAX_PAGES_PER_KEYWORD; page += 1) {
        if (options.shouldCancel?.() || jobsFoundTerm >= maxJobsPerTerm) break;
        if (page > 1) await sleep(delayMs);
        const result = await fetchSearchPage(fetchImpl, keyword, page);
        for (const row of result.rows) {
          if (jobsFoundTerm >= maxJobsPerTerm) break;
          const listing = mapUnstopListing(row);
          if (!listing || seenUrls.has(listing.job.jobUrl)) continue;
          if (
            !matchesUnstopLocation(
              listing,
              cities,
              options.workplaceTypes,
              options.includeRemote ?? true,
            )
          ) {
            continue;
          }
          if (!durationFits(listing.duration, duration)) continue;
          seenUrls.add(listing.job.jobUrl);
          jobs.push(listing.job);
          jobsFoundTerm += 1;
        }
        if (page >= result.lastPage) break;
      }
    } catch (error) {
      errors.push(
        `${keyword}: ${error instanceof Error ? error.message : "unexpected error"}`,
      );
    }

    options.onProgress?.({
      type: "term_complete",
      termIndex,
      termTotal: keywords.length,
      searchTerm: keyword,
      jobsFoundTerm,
    });
    if (index < keywords.length - 1) await sleep(delayMs);
  }

  if (jobs.length === 0 && errors.length > 0) {
    return { success: false, jobs: [], error: errors.join("; ") };
  }
  return errors.length > 0
    ? { success: true, jobs, errors }
    : { success: true, jobs };
}
