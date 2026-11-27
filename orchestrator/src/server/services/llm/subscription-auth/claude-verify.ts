import { DEFAULT_CLAUDE_CLI_SCORING_MODEL } from "@shared/settings-registry";
import { ClaudeCliClient } from "../claude-cli/client";
import { truncate } from "../utils/string";
import { resolveClaudeCliRuntimeForScope } from "./claude-runtime";
import type { CliAuthScope } from "./scope";

const VERIFY_TIMEOUT_MS = 45_000;

/**
 * Cheap end-to-end check of the user's stored Claude login: one tiny Haiku
 * call at low effort through the same CLI path scoring uses. Used only by
 * the explicit "Test" action, never on status polls.
 */
export async function verifyClaudeToken(
  scope: CliAuthScope,
): Promise<{ ok: boolean; message: string }> {
  const client = new ClaudeCliClient({
    resolveRuntime: () => resolveClaudeCliRuntimeForScope(scope),
    resolveEffort: async () => "low",
    requestTimeoutMs: VERIFY_TIMEOUT_MS,
  });
  try {
    await client.callJson({
      model: DEFAULT_CLAUDE_CLI_SCORING_MODEL,
      messages: [{ role: "user", content: "Reply OK by setting ok to true." }],
      jsonSchema: {
        name: "verify",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    });
    return { ok: true, message: "Claude subscription works." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: truncate(message, 300) };
  }
}
