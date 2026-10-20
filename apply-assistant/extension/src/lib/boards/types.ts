import type { Ats } from "../../../../server/src/ats";

/** What every application system's public job board offers the lookups. */

export type { Ats };

export interface BoardJob {
  readonly id: string;
  readonly title: string;
  readonly location: string;
  readonly url: string;
}

export interface BoardDeps {
  readonly fetch: typeof fetch;
  /** Called before each outside request, to stay polite. */
  readonly pause: () => Promise<void>;
}

export interface BoardListing {
  readonly jobs: readonly BoardJob[];
  /** Descriptions already in the listing (Ashby), so matching needs no extra requests. */
  readonly descriptions?: Readonly<Record<string, string>>;
}

export interface BoardApi {
  readonly ats: Ats;
  /** True when the employer has a board under this token. */
  exists(deps: BoardDeps, token: string): Promise<boolean>;
  list(deps: BoardDeps, token: string): Promise<BoardListing | null>;
  /** Description HTML/text for the given postings (for matching). */
  describe(
    deps: BoardDeps,
    token: string,
    ids: readonly string[],
    listing: BoardListing,
  ): Promise<Record<string, string>>;
  /** Whether the posting is still open, and its public link. */
  verify(
    deps: BoardDeps,
    token: string,
    postingId: string,
  ): Promise<{ live: boolean; url: string }>;
  /** The posting's application-form definition, or null when the posting is gone. */
  form(deps: BoardDeps, token: string, postingId: string): Promise<unknown>;
}

export async function getJson(
  deps: BoardDeps,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  await deps.pause();
  try {
    const res = await deps.fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });
    return res.ok ? ((await res.json()) as unknown) : null;
  } catch {
    return null;
  }
}
