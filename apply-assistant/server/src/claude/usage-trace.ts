import type { TraceRecord } from "../store/trace-store.js";
import type { UsageListener } from "./answerer.js";

/** Each Claude call made for a job goes into its trail (the Progress page adds them up). */
export const traceUsage =
  (trace: TraceRecord, jobId: string): UsageListener =>
  (usage) =>
    trace({
      jobId,
      kind: "claude-usage",
      message: `Claude ${usage.model}: ${usage.inputTokens} in / ${usage.outputTokens} out tokens${
        usage.cost === null ? "" : ` (about $${usage.cost.toFixed(4)})`
      }`,
      data: usage,
    });
