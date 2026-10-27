import { z } from "zod";
import type { JobOpsJobDetail } from "../jobops/client.js";
import type { ResumeFacts, SkillFact } from "./resume-facts.js";

/**
 * The resume as this job's tailored PDF has it: Job Ops rewrites the summary, headline and
 * skills per job and picks its projects; experience and education are the design resume's.
 * Claude writes from this, so its answers match the file that's uploaded.
 */

const tailoredSkills = z.array(
  z.object({
    name: z.string().default(""),
    keywords: z.array(z.string()).nullable().optional(),
  }),
);

function parseSkills(json: string | null | undefined): SkillFact[] | null {
  if (!json) return null;
  try {
    const skills = tailoredSkills.parse(JSON.parse(json));
    return skills.length > 0
      ? skills.map((s) => ({
          name: s.name,
          keywords: (s.keywords ?? []).map((k) => k.trim()).filter(Boolean),
        }))
      : null;
  } catch {
    return null;
  }
}

export function tailoredFor(
  resume: ResumeFacts,
  job: Pick<
    JobOpsJobDetail,
    | "tailoredSummary"
    | "tailoredHeadline"
    | "tailoredSkills"
    | "selectedProjectIds"
  >,
): ResumeFacts {
  const summary = job.tailoredSummary?.trim();
  // Not tailored yet: the design resume as it is.
  if (!summary) return resume;
  const projectIds = new Set(
    (job.selectedProjectIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return {
    ...resume,
    summary,
    headline: job.tailoredHeadline?.trim() || undefined,
    skills: parseSkills(job.tailoredSkills) ?? resume.skills,
    projects: (resume.projects ?? []).filter((p) => projectIds.has(p.id)),
  };
}
