import {
  getCountryNameVariants,
  normalizeCountryKey,
} from "@shared/location-support.js";
import type { CreateJobInput } from "@shared/types/jobs";
import { firstLink, headerParts, htmlToText, isJobSeeker } from "./text";

/**
 * Hacker News "Ask HN: Who is hiring?": the monthly thread where startups post their open
 * roles, read through HN's public Algolia API. One thread request and one items request a
 * run, whatever the number of search terms. Each top-level post becomes one job.
 */

const SEARCH_URL =
  "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10";
const itemUrl = (id: string) => `https://hn.algolia.com/api/v1/items/${id}`;
const postLink = (id: string) => `https://news.ycombinator.com/item?id=${id}`;
const REQUEST_TIMEOUT_MS = 30_000;

const ROLE =
  /\b(engineer|developer|programmer|architect|designer|scientist|manager|lead|head of|founding|sre|devops|intern|analyst|researcher|marketer|writer|recruiter|specialist|consultant)\b/i;
/** Header parts that aren't a place: pay, contract kind, funding stage, links. */
const NOT_A_PLACE =
  /https?:|[$€£₹]|\b\d+k\b|full[- ]?time|part[- ]?time|contract|freelance|equity|visa|\b(pre-seed|seed|series [a-e]|bootstrapped|profitable|yc [wsfx]\d{2})\b/i;
const REMOTE = /\bremote\b/i;
const OFFICE = /\b(on-?site|hybrid|in[- ]office|office)\b/i;
/** A remote post kept to some region ("REMOTE (US)", "Remote, EU time zones"). */
const REGION_LIMIT =
  /\b(us|usa|u\.s\.?|united states|canada|eu|europe|uk|emea|americas|latam|apac|north america|[pecm][sd]?t|cet|time ?zones?)\b/i;

export type WorkplaceType = "remote" | "hybrid" | "onsite";

export interface HackerNewsProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}

export interface RunHackerNewsOptions {
  searchTerms?: string[];
  selectedCountry?: string;
  workplaceTypes?: WorkplaceType[];
  maxJobsPerTerm?: number;
  onProgress?: (event: HackerNewsProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface HackerNewsResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

export interface HackerNewsPost {
  readonly id: string;
  readonly text: string;
  readonly createdAt?: string;
}

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const termWords = (term: string): string[] =>
  term.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);

/** Every word of the search term is somewhere in the post. */
export function matchesTerm(text: string, term: string): boolean {
  const lower = text.toLowerCase();
  return termWords(term).every((word) => lower.includes(word));
}

/** The header's place fits the searched country: there, worldwide, or remote without a region limit. */
export function matchesHnLocation(
  header: string,
  selectedCountry: string | undefined,
): boolean {
  const country = normalizeCountryKey(selectedCountry);
  if (!country || country === "worldwide") return true;
  const lower = header.toLowerCase();
  if (getCountryNameVariants(country).some((v) => lower.includes(v.toLowerCase())))
    return true;
  if (/\b(worldwide|anywhere|global)\b/.test(lower)) return true;
  return REMOTE.test(header) && !REGION_LIMIT.test(header);
}

export function matchesWorkplace(
  header: string,
  workplaceTypes: readonly WorkplaceType[] | undefined,
): boolean {
  if (!workplaceTypes || workplaceTypes.length === 0) return true;
  const remote = REMOTE.test(header);
  const office = OFFICE.test(header) || !remote;
  return (
    (remote && workplaceTypes.includes("remote")) ||
    (office && (workplaceTypes.includes("onsite") || workplaceTypes.includes("hybrid")))
  );
}

/** The role to title the job with: a header part (one naming the term first), else a short body line. */
function roleOf(parts: readonly string[], body: string, term: string): string | undefined {
  const roles = parts
    .slice(1)
    // "Senior Backend Engineer, Data Engineer": one role each; commas in brackets stay.
    .flatMap((part) => part.split(/\s*(?:,|\band\b)\s*(?![^()]*\))/i))
    .map((role) => role.trim())
    .filter((role) => ROLE.test(role) && role.length < 160);
  const fromBody = body
    .split("\n")
    .map((line) => line.replace(/^[-*•·\s]+/, "").trim())
    .filter((line) => ROLE.test(line) && line.length < 100);
  const candidates = [...roles, ...fromBody];
  return candidates.find((role) => matchesTerm(role, term)) ?? candidates[0];
}

/** A hiring post as a job for `term`, or null when it isn't an employer's post that fits. */
export function mapHackerNewsPost(
  post: HackerNewsPost,
  term: string,
): CreateJobInput | null {
  const text = htmlToText(post.text);
  const parts = headerParts(text);
  const header = parts.join(" | ");
  if (isJobSeeker(header, text)) return null;
  const employer = (parts[0] ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/^\W+|\W+$/g, "")
    .trim()
    .slice(0, 120);
  if (employer.length < 2) return null;
  const title = roleOf(parts, text.split("\n").slice(1).join("\n"), term);
  if (!title) return null;

  const jobUrl = postLink(post.id);
  const link = firstLink(text);
  const location = parts
    .slice(1)
    .filter((part) => !ROLE.test(part) && !NOT_A_PLACE.test(part))
    .join(" · ")
    .slice(0, 200);
  return {
    source: "hackernews",
    sourceJobId: post.id,
    title: title.slice(0, 160),
    employer,
    jobUrl,
    applicationLink: link && !link.includes("ycombinator.com") ? link : jobUrl,
    location: location || (REMOTE.test(header) ? "Remote" : undefined),
    jobDescription: text.slice(0, 20_000),
    datePosted: post.createdAt,
    isRemote: REMOTE.test(header),
  };
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Hacker News request failed with status ${response.status}`);
  return response.json();
}

/** This month's "Who is hiring?" top-level posts. */
export async function fetchHiringPosts(fetchImpl: typeof fetch): Promise<HackerNewsPost[]> {
  const search = asRecord(await getJson(fetchImpl, SEARCH_URL));
  const hits = Array.isArray(search?.hits) ? search.hits : null;
  if (!hits) throw new Error("Hacker News search returned an invalid response");
  const thread = hits
    .map(asRecord)
    .find((hit) => /^ask hn: who is hiring\?/i.test(asString(hit?.title) ?? ""));
  const threadId = thread ? String(thread.objectID ?? "") : "";
  if (!threadId) throw new Error("Hacker News has no hiring thread this month");

  const item = asRecord(await getJson(fetchImpl, itemUrl(threadId)));
  if (!Array.isArray(item?.children))
    throw new Error("Hacker News returned an invalid hiring thread");
  return item.children.flatMap((child): HackerNewsPost[] => {
    const row = asRecord(child);
    const text = asString(row?.text);
    const id = row?.id;
    if (!text || (typeof id !== "number" && typeof id !== "string")) return [];
    return [{ id: String(id), text, createdAt: asString(row?.created_at) }];
  });
}

export async function runHackerNews(
  options: RunHackerNewsOptions = {},
): Promise<HackerNewsResult> {
  const searchTerms = options.searchTerms?.length
    ? options.searchTerms
    : ["software engineer"];
  const maxJobsPerTerm = Number.isFinite(options.maxJobsPerTerm)
    ? Math.max(1, Math.floor(options.maxJobsPerTerm as number))
    : 50;
  const jobs: CreateJobInput[] = [];
  const seen = new Set<string>();

  try {
    if (options.shouldCancel?.()) return { success: true, jobs };
    const posts = (await fetchHiringPosts(options.fetchImpl ?? fetch)).map(
      (post) => {
        const text = htmlToText(post.text);
        return { post, text, header: headerParts(text).join(" | ") };
      },
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
      for (const { post, text, header } of posts) {
        if (jobsFoundTerm >= maxJobsPerTerm) break;
        if (seen.has(post.id) || !matchesTerm(text, searchTerm)) continue;
        if (!matchesHnLocation(header, options.selectedCountry)) continue;
        if (!matchesWorkplace(header, options.workplaceTypes)) continue;
        const job = mapHackerNewsPost(post, searchTerm);
        if (!job) continue;
        seen.add(post.id);
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
          : "Unexpected error while running Hacker News extractor",
    };
  }
}
