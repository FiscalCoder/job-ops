import { type Response, Router } from "express";
import { z } from "zod";
import type { ClaudeAccess } from "../claude/access.js";
import type { UserSettingsRepo } from "../store/user-settings-repo.js";
import type { AuthedRequest } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/**
 * Your own settings: your Claude (Anthropic) API key. It's stored for you alone and never sent
 * back: the reply says only whose key is used and the key's last characters.
 */

const keyBody = z.object({
  apiKey: z
    .string()
    .trim()
    .regex(/^sk-ant-[A-Za-z0-9_-]{20,300}$/, "That isn't an Anthropic API key (sk-ant-…)"),
});

export function createSettingsRoutes(deps: {
  readonly settings: UserSettingsRepo;
  readonly access: ClaudeAccess | null;
}) {
  const { settings, access } = deps;
  const router = Router();

  const status = () => {
    const own = settings.claudeKey();
    return {
      // "yours", "server" (Job Ops' admin, no key saved) or null: Claude is off for you.
      source: access?.source() ?? null,
      hint: own ? `…${own.slice(-4)}` : null,
    };
  };

  router.get("/settings/claude", (_req, res) => sendOk(res, status()));

  router.put("/settings/claude", (req: AuthedRequest, res: Response) => {
    const body = keyBody.safeParse(req.body);
    if (!body.success) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        body.error.issues[0]?.message ?? "Invalid key",
      );
      return;
    }
    settings.setClaudeKey(body.data.apiKey);
    sendOk(res, status());
  });

  router.delete("/settings/claude", (_req, res) => {
    settings.setClaudeKey(null);
    sendOk(res, status());
  });

  return router;
}
