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

/** What a reply's usage says, cached prompt parts included. */
interface MessageUsage {
  readonly model: string;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
  };
}

/** Cache writes cost 1.25x the input price, reads 0.1x (5-minute cache). */
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

/**
 * A reply's cost, cached parts of the prompt included: they're billed apart from input_tokens,
 * so they're counted in as input-equivalent tokens (a write 1.25x, a read 0.1x).
 */
export function usageOfMessage(message: MessageUsage): ClaudeUsage {
  const { usage } = message;
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  return usageOf(
    message.model,
    Math.round(usage.input_tokens + write * CACHE_WRITE + read * CACHE_READ),
    usage.output_tokens,
  );
}
