import {
  durationFits,
  formatDuration,
  type MonthRange,
  parseDurationField,
} from "@shared/internship-duration.js";
import { toInternshipKeywords } from "@shared/internship-search.js";
import type { CreateJobInput, JobLocationEvidence } from "@shared/types/jobs";
import * as cheerio from "cheerio";

const ORIGIN = "https://internshala.com";
const LIST_PATH = "/internships_ajax/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
/** Pages of 40 cards read per keyword and city; enough for a day's new postings. */
const MAX_PAGES_PER_SEARCH = 2;
/** Detail pages opened per run for the full description. */
const MAX_DETAILS_PER_RUN = 40;
const REQUEST_DELAY_MS = 1_500;
const HOURS_PER_DAY = 24;

export interface InternshalaProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  location?: string;
  jobsFoundTerm?: number;
}

export interface RunInternshalaOptions {
  searchTerms?: string[];
  /** Cities to search; empty searches all of India. */
  cities?: string[];
  /** Lengths wanted; null means any length. */
  duration?: MonthRange | null;
  maxJobsPerTerm?: number;
  /** Skip cards older than this (from the card's "posted" label); 0 keeps all. */
  maxAgeHours?: number;
  /** Jobs already stored: kept, but their detail pages aren't re-opened. */
  existingJobUrls?: readonly string[];
  shouldCancel?: () => boolean;
  onProgress?: (event: InternshalaProgressEvent) => void;
  fetchImpl?: typeof fetch;
  delayMs?: number;
}

export interface InternshalaResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
  /** Searches that failed while others succeeded. */
  errors?: string[];
}

export interface InternshalaCard {
  id: string;
  title: string;
  employer: string;
  jobUrl: string;
  locations: string[];
  stipend?: string;
  durationText?: string;
  postedText?: string;
  about?: string;
  skills: string[];
}

interface InternshalaDetail {
  description?: string;
  datePosted?: string;
  deadline?: string;
}

function cityToSlug(city: string): string {
  return city
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildInternshalaListUrl(args: {
  keyword: string;
  city?: string | null;
  duration?: MonthRange | null;
  page?: number;
}): string {
  const segments: string[] = [];
  const citySlug = args.city ? cityToSlug(args.city) : "";
  if (citySlug) segments.push(`internship-in-${citySlug}`);
  segments.push(`keywords-${encodeURIComponent(args.keyword.trim())}`);
  // Internshala's filter is a maximum length in whole months (1-36).
  if (args.duration && args.duration.maxMonths < 36) {
    segments.push(
      `duration-${Math.max(1, Math.ceil(args.duration.maxMonths))}`,
    );
  }
  if (args.page && args.page > 1) segments.push(`page-${args.page}`);
  return `${ORIGIN}${LIST_PATH}${segments.join("/")}/`;
}

function cleanText(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Reads the listing cards from the list response's `internship_list_html`. */
export function parseInternshalaCards(html: string): InternshalaCard[] {
  const $ = cheerio.load(html);
  const cards: InternshalaCard[] = [];

  $(".individual_internship[internshipid]").each((_, element) => {
    const card = $(element);
    const employmentType = card.attr("employment_type");
    if (employmentType && employmentType !== "internship") return;

    const id = cleanText(card.attr("internshipid"));
    const href =
      card.attr("data-href") ?? card.find("a.job-title-href").attr("href");
    const title = cleanText(card.find(".job-internship-name").first().text());
    const employer = cleanText(card.find(".company-name").first().text());
    if (!id || !href || !title || !employer) return;

    let durationText: string | undefined;
    card.find(".row-1-item").each((__, item) => {
      if ($(item).find(".ic-16-calendar").length > 0) {
        durationText = cleanText($(item).find("span").first().text());
      }
    });

    // "<span><a>Mumbai</a> (Hybrid)</span>" or "<span><a>Thane</a>, <a>Vashi</a></span>"
    const locationText = cleanText(
      card.find(".locations > span").first().text() ||
        card.find(".locations").first().text(),
    );
    const locations = locationText
      .split(",")
      .map((text: string) => cleanText(text))
      .filter(
        (text: string, index: number, all: string[]) =>
          Boolean(text) && all.indexOf(text) === index,
      );

    const postedText = cleanText(
      card.find(".color-labels [class^='status'] span").first().text(),
    );

    cards.push({
      id,
      title,
      employer,
      jobUrl: new URL(href, ORIGIN).toString(),
      locations,
      stipend: cleanText(card.find(".stipend").first().text()) || undefined,
      durationText: durationText || undefined,
      postedText: postedText || undefined,
      about:
        cleanText(card.find(".about_job .text").first().text()) || undefined,
      skills: card
        .find(".job_skill")
        .map((__, item) => cleanText($(item).text()))
        .get()
        .filter(Boolean),
    });
  });

  return cards;
}

/** Age of a card from its label ("Today", "Few hours ago", "3 days ago", "1 week ago"). */
export function cardAgeHours(postedText: string | undefined): number | null {
  const text = postedText?.toLowerCase() ?? "";
  if (!text) return null;
  if (/just now|few hours|hours? ago|minutes? ago|today/.test(text)) return 0;
  if (/yesterday/.test(text)) return HOURS_PER_DAY;
  const match = /(\d+)\+?\s*(day|week|month)s?\s+ago/.exec(text);
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? "", 10);
  const days =
    match[2] === "day"
      ? amount
      : match[2] === "week"
        ? amount * 7
        : amount * 30;
  return days * HOURS_PER_DAY;
}

function toPostedPhrase(postedText: string | undefined): string | undefined {
  const age = cardAgeHours(postedText);
  if (age === null) return undefined;
  if (age === 0) return "today";
  const days = Math.round(age / HOURS_PER_DAY);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function isRemoteLocation(location: string): boolean {
  return /work from home|remote/i.test(location);
}

export function toLocationEvidence(locations: string[]): {
  location: string;
  isRemote: boolean;
  locationEvidence: JobLocationEvidence;
} {
  const onsite = locations.filter((value) => !isRemoteLocation(value));
  const isRemote = locations.length > 0 && onsite.length === 0;
  const label = isRemote
    ? "Remote, India"
    : onsite.length > 0
      ? `${onsite.join(", ")}, India`
      : "India";
  return {
    location: label,
    isRemote,
    locationEvidence: {
      rawLocation: locations.join(", ") || null,
      location: label,
      countryKey: "india",
      country: "india",
      isRemote,
      isHybrid: onsite.some((value) => /hybrid/i.test(value)),
      evidenceQuality: onsite.length > 0 || isRemote ? "approximate" : "weak",
      source: "internshala",
      sourceNotes: ["Internshala lists internships in India."],
    },
  };
}

function findJobPosting(value: unknown): Record<string, unknown> | null {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>)["@type"] === "JobPosting"
    ) {
      return item as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * The page's own "About the internship", "Who can apply"… sections, for pages
 * without JobPosting JSON-LD (multi-city postings have none).
 */
function readDetailSections($: cheerio.CheerioAPI): string | undefined {
  const container = $(".internship_details").first();
  if (container.length === 0) return undefined;
  container
    .find("script, style, .training_link_tag, a[href*='trainings.']")
    .remove();
  const sections: string[] = [];
  container.find(".section_heading").each((_, heading) => {
    const title = cleanText($(heading).text());
    const body = cleanText(
      $(heading)
        .nextUntil(".section_heading")
        .map((__, node) => $(node).text())
        .get()
        .join(" "),
    );
    if (title && body) sections.push(`${title}:\n${body}`);
  });
  const text = sections.join("\n\n");
  return text.length > 0 ? text : undefined;
}

/** Reads the JobPosting JSON-LD on a detail page, or its description sections. */
export function parseInternshalaDetail(html: string): InternshalaDetail | null {
  const $ = cheerio.load(html);
  let posting: Record<string, unknown> | null = null;
  $('script[type="application/ld+json"]').each((_, element) => {
    if (posting) return;
    try {
      posting = findJobPosting(JSON.parse($(element).text()));
    } catch {
      // Not every JSON-LD block is valid; the page has several.
    }
  });
  if (!posting) {
    const description = readDetailSections($);
    return description ? { description } : null;
  }
  const found = posting as Record<string, unknown>;
  const asText = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    description: asText(found.description),
    datePosted: asText(found.datePosted),
    deadline: asText(found.validThrough),
  };
}

export function toInternshalaJob(
  card: InternshalaCard,
  detail: InternshalaDetail | null,
): CreateJobInput {
  const duration = parseDurationField(card.durationText);
  const durationLabel = duration ? formatDuration(duration) : card.durationText;
  const place = toLocationEvidence(card.locations);
  const header = [
    durationLabel ? `Duration: ${durationLabel}` : null,
    card.stipend ? `Stipend: ${card.stipend}` : null,
    `Location: ${card.locations.join(", ") || "not stated"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const body = detail?.description ?? card.about;

  return {
    source: "internshala",
    sourceJobId: card.id,
    title: card.title,
    employer: card.employer,
    jobUrl: card.jobUrl,
    applicationLink: card.jobUrl,
    location: place.location,
    locationEvidence: place.locationEvidence,
    isRemote: place.isRemote,
    salary: card.stipend,
    jobType: durationLabel ? `Internship · ${durationLabel}` : "Internship",
    datePosted: detail?.datePosted ?? toPostedPhrase(card.postedText),
    deadline: detail?.deadline,
    skills: card.skills.length > 0 ? card.skills.join(", ") : undefined,
    jobDescription: body ? `${header}\n\n${body}` : header,
  };
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Internshala request failed with status ${response.status}`,
    );
  }
  return response.text();
}

interface ListPage {
  html: string;
  isLastPage: boolean;
}

async function fetchListPage(
  fetchImpl: typeof fetch,
  url: string,
): Promise<ListPage> {
  const text = await fetchText(fetchImpl, url, {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Internshala returned a non-JSON list response");
  }
  const record = payload as Record<string, unknown> | null;
  if (!record || typeof record.internship_list_html !== "string") {
    throw new Error("Internshala returned an invalid list response");
  }
  return {
    html: record.internship_list_html,
    isLastPage: record.is_last_page === true,
  };
}

const sleep = (ms: number) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function keepCard(
  card: InternshalaCard,
  options: { duration: MonthRange | null; maxAgeHours: number },
): boolean {
  if (!durationFits(parseDurationField(card.durationText), options.duration)) {
    return false;
  }
  if (options.maxAgeHours > 0) {
    const age = cardAgeHours(card.postedText);
    // Labels round to whole days, so allow one more day than the window.
    if (age !== null && age > options.maxAgeHours + HOURS_PER_DAY) return false;
  }
  return true;
}

export async function runInternshala(
  options: RunInternshalaOptions = {},
): Promise<InternshalaResult> {
  const keywords = toInternshipKeywords(
    options.searchTerms?.length ? options.searchTerms : ["marketing"],
  );
  const cities: Array<string | null> = options.cities?.length
    ? options.cities
    : [null];
  const maxJobsPerTerm = Math.max(1, Math.floor(options.maxJobsPerTerm ?? 20));
  const duration = options.duration ?? null;
  const maxAgeHours = Math.max(0, options.maxAgeHours ?? 0);
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayMs = options.delayMs ?? REQUEST_DELAY_MS;
  const existing = new Set(options.existingJobUrls ?? []);
  const cards = new Map<string, InternshalaCard>();
  const searches = keywords.flatMap((keyword) =>
    cities.map((city) => ({ keyword, city })),
  );
  const errors: string[] = [];

  for (const [index, search] of searches.entries()) {
    if (options.shouldCancel?.()) break;
    const termIndex = index + 1;
    const location = search.city ?? undefined;
    options.onProgress?.({
      type: "term_start",
      termIndex,
      termTotal: searches.length,
      searchTerm: search.keyword,
      location,
    });

    let foundForSearch = 0;
    try {
      for (let page = 1; page <= MAX_PAGES_PER_SEARCH; page += 1) {
        if (options.shouldCancel?.() || foundForSearch >= maxJobsPerTerm) break;
        const url = buildInternshalaListUrl({ ...search, duration, page });
        const listPage = await fetchListPage(fetchImpl, url);
        for (const card of parseInternshalaCards(listPage.html)) {
          if (foundForSearch >= maxJobsPerTerm) break;
          if (cards.has(card.jobUrl)) continue;
          if (!keepCard(card, { duration, maxAgeHours })) continue;
          cards.set(card.jobUrl, card);
          foundForSearch += 1;
        }
        if (listPage.isLastPage) break;
        await sleep(delayMs);
      }
    } catch (error) {
      errors.push(
        `${search.keyword}${location ? ` in ${location}` : ""}: ${
          error instanceof Error ? error.message : "unexpected error"
        }`,
      );
    }

    options.onProgress?.({
      type: "term_complete",
      termIndex,
      termTotal: searches.length,
      searchTerm: search.keyword,
      location,
      jobsFoundTerm: foundForSearch,
    });
  }

  if (cards.size === 0 && errors.length > 0) {
    return { success: false, jobs: [], error: errors.join("; ") };
  }

  const jobs: CreateJobInput[] = [];
  let detailsOpened = 0;
  for (const card of cards.values()) {
    let detail: InternshalaDetail | null = null;
    const shouldOpen =
      !existing.has(card.jobUrl) &&
      detailsOpened < MAX_DETAILS_PER_RUN &&
      !options.shouldCancel?.();
    if (shouldOpen) {
      detailsOpened += 1;
      await sleep(delayMs);
      try {
        detail = parseInternshalaDetail(
          await fetchText(fetchImpl, card.jobUrl, { Accept: "text/html" }),
        );
      } catch {
        // Keep the card's summary when the detail page can't be read.
        detail = null;
      }
    }
    jobs.push(toInternshalaJob(card, detail));
  }

  return errors.length > 0
    ? { success: true, jobs, errors }
    : { success: true, jobs };
}
