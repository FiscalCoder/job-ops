import { asyncRoute, ok } from "@infra/http";
import { getAiSpend } from "@server/services/ai-spend/ai-spend-service";
import { type Request, type Response, Router } from "express";

export const aiSpendRouter = Router();

aiSpendRouter.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    ok(res, await getAiSpend());
  }),
);
