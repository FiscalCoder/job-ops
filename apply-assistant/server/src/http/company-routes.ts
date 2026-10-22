import { type Response, Router } from "express";
import { z } from "zod";
import type { CompanyLimitsRepo } from "../store/company-limits-repo.js";
import type { AuthedRequest } from "./auth.js";
import { sendError, sendOk } from "./envelope.js";

/** A company's limit: at most N applications from you in a window of days. */
const limitBody = z.object({
  name: z.string().trim().min(1).max(200),
  maxApplications: z.number().int().min(1).max(50),
  windowDays: z.number().int().min(1).max(730),
  note: z.string().trim().max(300).optional().default(""),
});

/** Companies that take only so many applications from you (Amazon: one per six months). */
export function createCompanyRoutes(limits: CompanyLimitsRepo) {
  const router = Router();

  router.get("/company-limits", (_req, res) => sendOk(res, limits.list()));

  router.put("/company-limits", (req: AuthedRequest, res: Response) => {
    const body = limitBody.safeParse(req.body);
    if (!body.success) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "A company name, how many applications (1-50) and over how many days (1-730)",
      );
      return;
    }
    sendOk(res, limits.save(body.data));
  });

  router.delete("/company-limits/:id", (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !limits.delete(id)) {
      sendError(res, 404, "NOT_FOUND", "No such company limit");
      return;
    }
    sendOk(res, { deleted: id });
  });

  return router;
}
