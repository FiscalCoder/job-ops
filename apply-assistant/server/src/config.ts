import { z } from "zod";

export interface AppConfig {
  readonly port: number;
  readonly jobOpsBaseUrl: string;
  readonly dataDir: string;
  readonly authCacheSeconds: number;
  /** Null without ANTHROPIC_API_KEY: unrecognised questions then stay "needs you". */
  readonly claude: ClaudeConfig;
}

export interface ClaudeConfig {
  /** The server's own key: its admin's. Others add theirs in Apply Copilot's settings. */
  readonly apiKey: string | null;
  /** Matches form questions to your answers (cheap, fast). */
  readonly mapModel: string;
  /** Drafts written answers to open-ended questions (always for your review). */
  readonly draftModel: string;
}

const DEFAULT_PORT = 3006;
const DEFAULT_AUTH_CACHE_SECONDS = 60;
const DEFAULT_MAP_MODEL = "claude-haiku-5-5";
const DEFAULT_DRAFT_MODEL = "claude-sonnet-5-5";

const envSchema = z.object({
  JOBOPS_BASE_URL: z
    .string({
      required_error: "JOBOPS_BASE_URL is required (e.g. http://job-ops:3001)",
    })
    .url(),
  APPLY_DATA_DIR: z
    .string({
      required_error: "APPLY_DATA_DIR is required (folder for apply.db)",
    })
    .min(1),
  APPLY_PORT: z.coerce
    .number({ invalid_type_error: "APPLY_PORT must be a number" })
    .int()
    .positive()
    .optional(),
  APPLY_AUTH_CACHE_SECONDS: z.coerce.number().int().min(0).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  APPLY_MAP_MODEL: z.string().min(1).optional(),
  APPLY_DRAFT_MODEL: z.string().min(1).optional(),
});

/** Reads and validates configuration; throws a readable error listing every problem. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(
      `Invalid apply-assistant configuration:\n  ${problems.join("\n  ")}`,
    );
  }
  const values = parsed.data;
  const apiKey = values.ANTHROPIC_API_KEY?.trim();
  return {
    port: values.APPLY_PORT ?? DEFAULT_PORT,
    jobOpsBaseUrl: values.JOBOPS_BASE_URL.replace(/\/+$/, ""),
    dataDir: values.APPLY_DATA_DIR,
    authCacheSeconds:
      values.APPLY_AUTH_CACHE_SECONDS ?? DEFAULT_AUTH_CACHE_SECONDS,
    claude: {
      apiKey: apiKey || null,
      mapModel: values.APPLY_MAP_MODEL ?? DEFAULT_MAP_MODEL,
      draftModel: values.APPLY_DRAFT_MODEL ?? DEFAULT_DRAFT_MODEL,
    },
  };
}
