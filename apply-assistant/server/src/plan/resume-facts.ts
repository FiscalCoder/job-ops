import { isValid, parse } from "date-fns";
import { z } from "zod";
import { htmlToPoints, htmlToText } from "../resolver/text.js";

/**
 * Turns Job Ops' design resume (the same source as the tailored PDF) into the facts a form asks
 * for. Experience and education are never rewritten, so typed fields match the uploaded file.
 * Name and city deliberately do NOT come from here: they live in the answer bank.
 */

export interface YearMonth {
  readonly year: number;
  readonly month: number | null;
}

export interface Period {
  readonly start: YearMonth | null;
  readonly end: YearMonth | null;
  readonly current: boolean;
}

export type DegreeLevel =
  | "high_school"
  | "associate"
  | "bachelor"
  | "master"
  | "doctorate";

export interface ExperienceFact extends Period {
  readonly company: string;
  readonly title: string;
  readonly location: string;
  readonly description: string;
}

export interface EducationFact {
  readonly school: string;
  readonly degree: string;
  readonly level: DegreeLevel | null;
  readonly area: string;
  readonly startYear: number | null;
  readonly endYear: number | null;
}

export interface ResumeFacts {
  readonly email: string | null;
  readonly phone: string | null;
  readonly links: {
    readonly linkedin: string | null;
    readonly github: string | null;
    readonly website: string | null;
  };
  readonly experience: readonly ExperienceFact[];
  readonly education: readonly EducationFact[];
  /** Context for the question model only; never typed into a form as-is. */
  readonly summary: string;
  readonly skills: readonly SkillFact[];
  /** The tailored resume's headline (none on the design resume). */
  readonly headline?: string;
  readonly projects?: readonly ProjectFact[];
}

export interface ProjectFact {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface SkillFact {
  readonly name: string;
  readonly keywords: readonly string[];
}

const NO_PERIOD: Period = { start: null, end: null, current: false };
const MONTH_FORMATS = ["MMMM yyyy", "MMM yyyy", "MM/yyyy", "M/yyyy", "MM-yyyy"];
const REFERENCE_DATE = new Date(2000, 0, 1);

function parsePoint(text: string): YearMonth | null {
  const trimmed = text.trim().replace(/\.$/, "");
  if (/^\d{4}$/.test(trimmed)) return { year: Number(trimmed), month: null };
  for (const format of MONTH_FORMATS) {
    const date = parse(trimmed, format, REFERENCE_DATE);
    if (isValid(date))
      return { year: date.getFullYear(), month: date.getMonth() + 1 };
  }
  return null;
}

/** "September 2023 - Present", "Jan 2020 – Aug 2023", "2015 - 2019", "2019" (= finished then). */
export function parsePeriod(text: string): Period {
  const parts = text.split(/\s+[-–—]\s+|\s+to\s+/i).map((p) => p.trim());
  if (parts.length === 1) {
    const end = parsePoint(parts[0] ?? "");
    return end ? { ...NO_PERIOD, end } : NO_PERIOD;
  }
  const start = parsePoint(parts[0] ?? "");
  const endText = parts[1] ?? "";
  const current = /^(present|current|now|ongoing|till date)$/i.test(endText);
  const end = current ? null : parsePoint(endText);
  if (!start && !end && !current) return NO_PERIOD;
  return { start, end, current };
}

const LEVEL_PATTERNS: readonly [DegreeLevel, RegExp][] = [
  ["doctorate", /\b(ph\.?\s?d|doctor(ate)?|d\.?phil)\b/i],
  [
    "master",
    /\b(m\.?\s?tech|m\.?\s?e|m\.?\s?s|m\.?\s?sc|mca|mba|m\.?\s?a|m\.?\s?com|master'?s?)\b/i,
  ],
  [
    "bachelor",
    /\b(b\.?\s?tech|b\.?\s?e|b\.?\s?s|b\.?\s?sc|bca|bba|b\.?\s?a|b\.?\s?com|bachelor'?s?|undergraduate)\b/i,
  ],
  ["associate", /\b(diploma|associate'?s?)\b/i],
  [
    "high_school",
    /\b(x{1}i{0,2}|10th|12th|hsc|ssc|higher secondary|senior secondary|secondary|pre[-\s]?university|puc|intermediate|high school|a[-\s]?levels?)\b/i,
  ],
];

const LEVEL_RANK: Record<DegreeLevel, number> = {
  doctorate: 5,
  master: 4,
  bachelor: 3,
  associate: 2,
  high_school: 1,
};

/** Canonical level for a degree name, or null when it isn't a recognised degree. */
export function degreeLevel(degree: string): DegreeLevel | null {
  // A postgraduate diploma is a certificate, not a degree level forms can pick.
  if (/\b(pg|post[-\s]?graduate)\s*diploma\b/i.test(degree)) return null;
  return (
    LEVEL_PATTERNS.find(([, pattern]) => pattern.test(degree))?.[0] ?? null
  );
}

const text = z
  .string()
  .nullable()
  .optional()
  .transform((v) => v?.trim() ?? "");
const link = z
  .object({ url: z.string().nullable().optional() })
  .nullable()
  .optional()
  .transform((v) => v?.url?.trim() || null);
/** Forms validate URLs, so a bare "example.dev" becomes "https://example.dev". */
const withScheme = (url: string | null) =>
  url && !/^https?:\/\//i.test(url) ? `https://${url}` : url;

const items = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({ items: z.array(item).optional().default([]) })
    .optional()
    .transform((s) => s?.items ?? []);
const hidden = z.boolean().nullable().optional();

const designResumeSchema = z.object({
  basics: z
    .object({ email: text, phone: text, website: link })
    .partial()
    .optional()
    .default({}),
  sections: z.object({
    summary: z
      .object({ hidden, content: text })
      .optional()
      .transform((s) => (s && s.hidden !== true ? s.content : "")),
    skills: items(
      z.object({
        hidden,
        name: text,
        keywords: z.array(z.string()).nullable().optional(),
      }),
    ),
    profiles: items(z.object({ hidden, network: text, website: link })),
    experience: items(
      z.object({
        hidden,
        company: text,
        position: text,
        location: text,
        period: text,
        description: text,
      }),
    ),
    education: items(
      z.object({
        hidden,
        school: text,
        degree: text,
        area: text,
        period: text,
      }),
    ),
    projects: items(
      z.object({ hidden, id: text, name: text, description: text }),
    ),
  }),
});

const visible = <T extends { hidden?: boolean | null }>(list: readonly T[]) =>
  list.filter((item) => item.hidden !== true);

const startOf = (fact: Period) =>
  fact.current
    ? Number.POSITIVE_INFINITY
    : (fact.end?.year ?? 0) * 12 + (fact.end?.month ?? 12);

export function resumeFacts(designResume: unknown): ResumeFacts {
  const resume = designResumeSchema.parse(designResume);
  const profileUrl = (network: RegExp) =>
    withScheme(
      visible(resume.sections.profiles).find((p) => network.test(p.network))
        ?.website ?? null,
    );

  const experience = visible(resume.sections.experience)
    .map((e) => ({
      company: e.company,
      title: e.position,
      location: e.location,
      description: htmlToPoints(e.description),
      ...parsePeriod(e.period),
    }))
    .sort((a, b) => startOf(b) - startOf(a));

  const education = visible(resume.sections.education)
    .map((e) => {
      const period = parsePeriod(e.period);
      return {
        school: e.school,
        degree: e.degree,
        level: degreeLevel(e.degree),
        area: e.area,
        startYear: period.start?.year ?? null,
        endYear: period.end?.year ?? null,
      };
    })
    .sort(
      (a, b) =>
        (b.level ? LEVEL_RANK[b.level] : 0) -
        (a.level ? LEVEL_RANK[a.level] : 0),
    );

  return {
    email: resume.basics.email || null,
    phone: resume.basics.phone || null,
    links: {
      linkedin: profileUrl(/linkedin/i),
      github: profileUrl(/github/i),
      website: withScheme(resume.basics.website ?? null),
    },
    experience,
    education,
    summary: htmlToText(resume.sections.summary),
    skills: visible(resume.sections.skills).map((skill) => ({
      name: skill.name,
      keywords: (skill.keywords ?? []).map((k) => k.trim()).filter(Boolean),
    })),
    projects: visible(resume.sections.projects).map((p) => ({
      id: p.id,
      name: p.name,
      description: htmlToText(p.description),
    })),
  };
}
