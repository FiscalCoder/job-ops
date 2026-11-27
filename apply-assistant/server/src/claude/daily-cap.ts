import type { MessagesApi } from "./answerer.js";

/** Stops a user's Claude calls once they've used `limit` tokens today (UTC); 0 means no cap. */

export class ClaudeDailyLimitError extends Error {
  constructor(limit: number) {
    super(
      `Daily Claude limit reached (${limit.toLocaleString("en-US")} tokens); it resets at midnight UTC. Raise APPLY_DAILY_CLAUDE_TOKENS to allow more.`,
    );
    this.name = "ClaudeDailyLimitError";
  }
}

export function dailyTokenCap(
  inner: MessagesApi,
  usedSince: (iso: string) => number,
  limit: number,
  now: () => Date = () => new Date(),
): MessagesApi {
  if (limit <= 0) return inner;
  return {
    create(params) {
      const midnight = `${now().toISOString().slice(0, 10)}T00:00:00.000Z`;
      if (usedSince(midnight) >= limit)
        return Promise.reject(new ClaudeDailyLimitError(limit));
      return inner.create(params);
    },
  };
}
