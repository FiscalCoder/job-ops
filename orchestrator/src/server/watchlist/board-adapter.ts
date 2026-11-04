import type { ManualJobDraft, WatchlistSelectedSource } from "@shared/types";
import { z } from "zod";
import type { WatchlistCatalogSourceAdapter } from "./adapters/types";

/**
 * A company job board on an ATS with a public, no-login job list (Keka, Darwinbox, Zoho
 * Recruit, Lever, SmartRecruiters): one spec per system says how to read the board's URL and
 * its postings; this turns it into a Watchlist source. Requests go only to the system's own
 * hosts (each spec checks the URL), never follow redirects, and time out.
 */

export interface BoardPosting {
  readonly id: string;
  readonly title: string;
  readonly jobUrl: string;
  readonly applicationLink?: string;
  readonly location?: string | null;
  /** ISO date, when the board says. */
  readonly postedAt?: string | null;
  readonly descriptionHtml?: string | null;
  readonly employer?: string | null;
}

export interface BoardRef {
  /** Short, stable name of the board on its system ("acme"). */
  readonly key: string;
  /** The board's careers page, in one canonical form. */
  readonly careersUrl: string;
}

export interface BoardSpec {
  readonly sourceType: string;
  readonly label: string;
  readonly placeholder: string;
  readonly helpText: string;
  /** The board for a URL on this system, or null when the URL isn't one of its boards. */
  parse(url: string): BoardRef | null;
  fetchPostings(board: BoardRef, signal?: AbortSignal): Promise<BoardPosting[]>;
  /** A posting's description when the list leaves it out. */
  fetchDescription?(
    board: BoardRef,
    posting: BoardPosting,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

const WATCHLIST_MAX_JOBS = 40;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 15 * 1024 * 1024;
/** A board read once is reused for its postings' details and drafts for a while. */
const BOARD_TTL_MS = 5 * 60_000;
const MAX_CACHED_BOARDS = 50;

const catalogSchema = z.object({
  label: z.string().trim().min(1).max(200),
  careersUrl: z.string().trim().url().max(2000),
});

/** GET or POST to an ATS's own host: no redirects, a timeout, a size cap. */
export async function readBoardUrl(
  url: string,
  options: {
    signal?: AbortSignal;
    method?: "GET" | "POST";
    body?: string;
    accept?: string;
  } = {},
): Promise<string> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const response = await fetch(url, {
    method: options.method ?? "GET",
    redirect: "manual",
    signal,
    headers: {
      accept: options.accept ?? "application/json, text/html;q=0.9",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: options.body } : {}),
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error(
      `${new URL(url).hostname} redirected the request (no such board?)`,
    );
  if (!response.ok)
    throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error("The job board's reply is too large");
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("The job board's reply is too large");
  return text;
}

export async function readBoardJson(
  url: string,
  options: Parameters<typeof readBoardUrl>[1] = {},
): Promise<unknown> {
  const text = await readBoardUrl(url, { ...options, accept: "application/json" });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${new URL(url).hostname} returned invalid JSON`);
  }
}

/** Readable text from a posting's HTML (line breaks kept at blocks). */
export function htmlText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "acme-labs" → "Acme Labs". */
export const keyToLabel = (key: string): string =>
  key
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");

/** Epoch milliseconds, seconds, or a date string → ISO; null when it isn't a date. */
export function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

export function boardAdapter(spec: BoardSpec): WatchlistCatalogSourceAdapter {
  const cache = new Map<
    string,
    { expires: number; postings: Promise<BoardPosting[]> }
  >();

  const boardOf = (careersUrl: string): BoardRef => {
    const board = spec.parse(careersUrl);
    if (!board) throw new Error(spec.helpText);
    return board;
  };

  const postingsOf = (board: BoardRef, signal?: AbortSignal) => {
    const now = Date.now();
    for (const [key, entry] of cache)
      if (entry.expires <= now) cache.delete(key);
    const kept = cache.get(board.careersUrl);
    if (kept) return kept.postings;
    if (cache.size >= MAX_CACHED_BOARDS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const postings = spec.fetchPostings(board, signal);
    cache.set(board.careersUrl, { expires: now + BOARD_TTL_MS, postings });
    // A failed read isn't kept: the next check asks again.
    postings.catch(() => cache.delete(board.careersUrl));
    return postings;
  };

  const sourceKey = (board: BoardRef) => `${spec.sourceType}:${board.key}`;

  const find = async (
    source: WatchlistSelectedSource,
    jobRef: string,
    signal?: AbortSignal,
  ) => {
    const board = boardOf(source.careersUrl);
    const posting = (await postingsOf(board, signal)).find(
      (p) => p.id === jobRef,
    );
    if (!posting)
      throw new Error(`That ${spec.label} posting is no longer on the board`);
    const description =
      posting.descriptionHtml ??
      (await spec.fetchDescription?.(board, posting, signal)) ??
      "";
    return { board, posting, description };
  };

  return {
    sourceType: spec.sourceType,
    descriptor: {
      sourceType: spec.sourceType,
      label: spec.label,
      catalogLabel: `${spec.label} company`,
      customSourceOptionLabel: `Choose your own ${spec.label} company`,
      customSourceSearchText: `custom ${spec.label.toLowerCase()} url`,
      customSourceInputLabel: `${spec.label} careers page URL`,
      customSourcePlaceholder: spec.placeholder,
      customSourceHelpText: spec.helpText,
      emptyCatalogText: `No ${spec.label} companies yet: paste a careers page.`,
      fetchingLabel: `Fetching from ${spec.label}...`,
      invalidUrlMessage: spec.helpText,
      supportsCustomSource: true,
      supportsBranding: false,
    },
    catalogSchema,
    parseCatalogSources(entries) {
      return z
        .array(catalogSchema)
        .parse(entries)
        .flatMap((entry) => {
          const board = spec.parse(entry.careersUrl);
          return board
            ? [
                {
                  id: sourceKey(board),
                  label: entry.label,
                  sourceType: spec.sourceType,
                  careersUrl: board.careersUrl,
                  cxsJobsUrl: null,
                },
              ]
            : [];
        });
    },
    hydrateSelectedSource(source) {
      const board = spec.parse(source.careersUrl);
      if (!board) return source;
      const label = source.label.trim();
      return {
        ...source,
        label: !label || label === source.careersUrl.trim() ? keyToLabel(board.key) : source.label,
        careersUrl: board.careersUrl,
        cxsJobsUrl: null,
      };
    },
    normalizeCustomSelection(input) {
      const board = boardOf(input.careersUrl);
      const label = input.label?.trim();
      return {
        label: label && label !== input.careersUrl.trim() ? label : keyToLabel(board.key),
        careersUrl: board.careersUrl,
      };
    },
    async fetchJobs(input) {
      const board = boardOf(input.source.careersUrl);
      const postings = [...(await postingsOf(board, input.signal))].sort(
        (a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""),
      );
      const jobs = postings.slice(0, WATCHLIST_MAX_JOBS).map((posting) => ({
        jobRef: posting.id,
        source: sourceKey(board),
        sourceJobId: posting.id,
        sourceType: spec.sourceType,
        title: posting.title,
        employer: posting.employer ?? input.source.label,
        jobUrl: posting.jobUrl,
        applicationLink: posting.applicationLink ?? posting.jobUrl,
        location: posting.location ?? null,
        postedAt: posting.postedAt ?? null,
      }));
      return { total: postings.length, fetched: jobs.length, jobs };
    },
    async fetchJobDetails(input) {
      const { posting, description } = await find(input.source, input.jobRef, input.signal);
      return { jobRef: input.jobRef, jobUrl: posting.jobUrl, descriptionHtml: description };
    },
    async prepareImportDraft(input) {
      const { board, posting, description } = await find(
        input.source,
        input.jobRef,
        input.signal,
      );
      const draft: ManualJobDraft = {
        source: sourceKey(board),
        sourceJobId: posting.id,
        title: posting.title,
        employer: posting.employer ?? input.source.label,
        jobUrl: posting.jobUrl,
        applicationLink: posting.applicationLink ?? posting.jobUrl,
        ...(posting.location ? { location: posting.location } : {}),
        jobDescription: htmlText(description),
      };
      return {
        draft,
        source: draft.source ?? null,
        sourceHost: new URL(posting.jobUrl).hostname,
      };
    },
  };
}
