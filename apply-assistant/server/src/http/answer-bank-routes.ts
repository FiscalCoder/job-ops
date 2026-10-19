import { type Response, Router } from "express";
import { z } from "zod";
import { BANK_KEYS, bankKeyDef } from "../bank/catalogue.js";
import { normalizeAnswer } from "../bank/normalize.js";
import { currencyOf } from "../plan/country.js";
import type { AnswerBankRepo } from "../store/answer-bank-repo.js";
import type { AuthedRequest } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/** Answer bank: the catalogue of keys the planner uses, with your saved values. */

const answerBody = z.object({
  value: z.string().max(5000),
  isProtected: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const answerKey = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9_.-]+$/i, "Use letters, digits, '.', '_' or '-'");

export function createAnswerBankRoutes(answers: AnswerBankRepo) {
  const router = Router();

  router.get("/answer-bank", (_req, res) => {
    const saved = new Map(answers.list().map((a) => [a.key, a]));
    const keys = BANK_KEYS.map((def) => {
      const answer = saved.get(def.key);
      return {
        ...def,
        value: answer?.value ?? null,
        updatedAt: answer?.updatedAt ?? null,
      };
    });
    const custom = [...saved.values()].filter((a) => !bankKeyDef(a.key));
    sendOk(res, { keys, custom });
  });

  router.put("/answer-bank/:key", (req: AuthedRequest, res: Response) => {
    const key = answerKey.safeParse(req.params.key);
    const body = answerBody.safeParse(req.body);
    if (!key.success || !body.success) {
      sendError(res, 400, "INVALID_REQUEST", "Invalid answer", {
        key: key.success ? undefined : key.error.flatten(),
        body: body.success ? undefined : body.error.flatten(),
      });
      return;
    }
    const definition = bankKeyDef(key.data);
    const normalized = normalizeAnswer(
      definition?.kind ?? "text",
      body.data.value,
      {
        defaultCurrency: currencyOf(
          answers.get("location.current_country")?.value,
        ),
      },
    );
    if (!normalized.ok) {
      sendError(
        res,
        400,
        "INVALID_ANSWER",
        `${definition?.label ?? key.data}: ${normalized.error}`,
      );
      return;
    }
    const saved = answers.upsert({
      key: key.data,
      value: normalized.value,
      isProtected:
        definition?.protected === true || (body.data.isProtected ?? false),
      notes: body.data.notes ?? null,
      updatedBy: req.user?.username ?? "unknown",
    });
    sendOk(res, saved);
  });

  return router;
}
