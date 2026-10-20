/**
 * What a Claude call cost, for the "model cost per application" target (plan §1). Prices are
 * dollars per million tokens, from Anthropic's model list (claude-api reference, 2026-10).
 * Haiku 5.5's price applies to prompts up to 100K tokens; ours are a few thousand.
 */

interface Price {
  readonly input: number;
  readonly output: number;
}

const PRICES: readonly [prefix: string, price: Price][] = [
  ["claude-haiku-5-5", { input: 0.1, output: 0.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10 }],
];

export interface ClaudeUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Dollars; null for a model without a known price. */
  readonly cost: number | null;
}

export function usageOf(
  model: string,
  inputTokens: number,
  outputTokens: number,
): ClaudeUsage {
  const price = PRICES.find(([prefix]) => model.startsWith(prefix))?.[1];
  return {
    model,
    inputTokens,
    outputTokens,
    cost: price
      ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000
      : null,
  };
}
