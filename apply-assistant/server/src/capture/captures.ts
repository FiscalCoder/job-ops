import { z } from "zod";
import type { JobOpsApi } from "../jobops/client.js";
import { LOOKUP_STATUSES } from "../resolver/lookups.js";
import type { ApplyTargetsRepo } from "../store/apply-targets-repo.js";
import type { CapturedLinksRepo } from "../store/captured-links-repo.js";
import { bestApplyLink, cleanApplyUrl, linkedInJobIdOf } from "./linkedin.js";

/**
 * Saves the company apply link the extension captured when you clicked Apply on a LinkedIn job:
 * finds that job in Job Ops, writes the link back (applicationLink + a note) and forgets the
 * job's old lookup result, so the next lookup starts from the real application page.
 */

export const captureSchema = z.object({
  linkedinJobId: z.string().regex(/^\d{6,20}$/),
  applyUrl: z.string().url().max(4_000),
  finalUrl: z.string().url().max(4_000).nullable().optional(),
});
export type CaptureInput = z.infer<typeof captureSchema>;

export type CaptureOutcome =
  | {
      readonly status: "saved" | "unchanged";
      readonly jobId: string;
      readonly title: string;
      readonly employer: string;
      readonly link: string;
    }
  | { readonly status: "unknown-job" }
  | { readonly status: "rejected"; readonly reason: string };

export interface CapturesDeps {
  readonly jobOps: JobOpsApi;
  readonly targets: ApplyTargetsRepo;
  readonly links: CapturedLinksRepo;
}

export function createCaptures({ jobOps, targets, links }: CapturesDeps) {
  return {
    async capture(token: string, input: CaptureInput): Promise<CaptureOutcome> {
      const first = cleanApplyUrl(input.applyUrl);
      if (!first)
        return { status: "rejected", reason: "Not a company web link" };
      const final = input.finalUrl ? cleanApplyUrl(input.finalUrl) : null;
      const link = bestApplyLink(first, final);

      const { jobs } = await jobOps.listJobs(token, LOOKUP_STATUSES);
      const job = jobs.find(
        (j) => linkedInJobIdOf(j.jobUrl) === input.linkedinJobId,
      );
      if (!job) return { status: "unknown-job" };

      const sourceUrl = `https://www.linkedin.com/jobs/view/${input.linkedinJobId}`;
      links.add({
        jobId: job.id,
        sourceUrl,
        capturedUrl: first,
        savedUrl: link,
      });
      const found = {
        jobId: job.id,
        title: job.title,
        employer: job.employer,
        link,
      };
      if (job.applicationLink === link)
        return { status: "unchanged", ...found };

      await jobOps.updateJob(token, job.id, { applicationLink: link });
      await jobOps.addNote(token, job.id, {
        title: "Apply link captured from LinkedIn",
        content: `LinkedIn's Apply button for this job opens ${link}`,
      });
      targets.remove(job.id);
      return { status: "saved", ...found };
    },
  };
}
