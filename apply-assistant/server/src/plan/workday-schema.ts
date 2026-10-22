import { z } from "zod";
import type { FieldType, FormField, FormSchema } from "./form-schema.js";
import { schemaHash } from "./form-schema.js";
import type { ResumeFacts } from "./resume-facts.js";

/**
 * Workday (PHASE1_GREENHOUSE_PLAN.md §12G): its application form only exists after you sign
 * in, one page at a time, so the extension reads the page you're on and the server plans just
 * that page. This turns the page's fields into a FormSchema the usual planner understands.
 *
 * Fields are found by Workday's stable markers: a container `data-automation-id="formField-<key>"`
 * around each field (key below), with the question as its label.
 */

export const workdayPageSchema = z.object({
  /** The wizard step ("My Information", "Application Questions", ...). */
  step: z.string().max(200),
  fields: z
    .array(
      z.object({
        /** The control's DOM id: how the driver finds it again. */
        ref: z.string().min(1).max(300),
        /** What follows "formField-" in the field container's data-automation-id. */
        key: z.string().max(200),
        label: z.string().max(500),
        kind: z.enum([
          "text",
          "textarea",
          "dropdown",
          "search",
          "radio",
          "checkbox",
          "date",
          "file",
        ]),
        required: z.boolean(),
        // Country dropdowns list ~250 choices.
        options: z.array(z.string().max(300)).max(500),
      }),
    )
    .max(200),
  /** My Experience's sections with an Add button, and how many entries each has now. */
  sections: z
    .array(
      z.object({
        /** The section's heading id ("Work-Experience-section"). */
        id: z.string().max(200),
        label: z.string().max(200),
        entries: z.number().int().min(0).max(100),
      }),
    )
    .max(30)
    .optional(),
});

export type WorkdayPage = z.infer<typeof workdayPageSchema>;
type PageField = WorkdayPage["fields"][number];

/** Workday's own field keys with a known meaning (the classifier's shared names). */
const CANONICAL: Record<string, string> = {
  "legalName--firstName": "first_name",
  "legalName--lastName": "last_name",
  email: "email",
  phoneNumber: "phone",
  // Search-and-pick: your country's name finds its "India (+91)".
  countryPhoneCode: "country",
  phoneType: "phone_type",
  country: "country",
  city: "location",
  candidateIsPreviousWorker: "worked_here",
  // Search-and-pick, one skill at a time: from your Job Ops resume.
  skills: "skills",
};

/** Optional extras, left to you. */
const LEFT_ALONE =
  /^(legalName--\w+Local|legalName--middleName|preferredCheck|extension|websites?|url|certification\w*|language\w*)$/;

/**
 * Work history and education entries ("workExperience-129--jobTitle"): the n-th entry on the
 * page is filled from the n-th on your Job Ops resume (most recent job, highest degree first).
 */
const HISTORY = /^(workExperience|education)-([^-]+)--/;
/** Other repeated sections (certifications, languages, websites): left to you. */
const REPEATED = /^(certification|language|website)s?-/i;

/** "history.experience.0.jobTitle" for each work history / education field, by entry order. */
function historyNames(fields: readonly PageField[]): Map<string, string> {
  const entries = new Map<string, number>();
  const names = new Map<string, string>();
  for (const field of fields) {
    const match = HISTORY.exec(field.ref);
    if (!match) continue;
    const section = match[1] === "workExperience" ? "experience" : "education";
    const entry = `${match[1]}-${match[2]}`;
    if (!entries.has(entry))
      entries.set(
        entry,
        [...entries.keys()].filter((e) => e.startsWith(`${match[1]}-`)).length,
      );
    names.set(
      field.ref,
      `history.${section}.${entries.get(entry)}.${field.ref.slice(match[0].length)}`,
    );
  }
  return names;
}

function typeOf(field: PageField, history: boolean): FieldType {
  if (REPEATED.test(field.ref)) return "hidden";
  // Dates are typed ("09/2025", "2019"), but only work history and education have answers.
  if (field.kind === "date") return history ? "text" : "hidden";
  if (!history && LEFT_ALONE.test(field.key) && !CANONICAL[field.key])
    return "hidden";
  if (field.key === "skills") return "multiselect";
  switch (field.kind) {
    case "textarea":
      return "textarea";
    case "file":
      return "file";
    case "dropdown":
    case "search":
    case "radio":
    case "checkbox":
      return "select";
    default:
      return "text";
  }
}

const SECTION: Record<string, FormField["section"]> = {
  "Voluntary Disclosures": "demographic",
  "Self Identify": "demographic",
};

export function parseWorkdayPage(page: WorkdayPage, title: string): FormSchema {
  const history = historyNames(page.fields);
  const fields: FormField[] = page.fields.map((f) => {
    const type = typeOf(f, history.has(f.ref));
    const canonical =
      f.kind === "file" ? "resume" : (history.get(f.ref) ?? CANONICAL[f.key]);
    return {
      ref: f.ref,
      ...(canonical ? { canonical } : {}),
      label: f.label.replace(/\*$/, "").trim(),
      type,
      required: f.required,
      // A lone checkbox is a one-choice question ("I consent to the terms").
      options: (f.kind === "checkbox" && f.options.length === 0
        ? [f.label]
        : f.options
      ).map((o) => {
        const label = o.replace(/\*$/, "").trim();
        return { label, value: label };
      }),
      section: SECTION[page.step] ?? "main",
    };
  });
  return {
    postingId: page.step,
    title,
    location: "",
    education: null,
    fields,
    hash: schemaHash({ step: page.step, fields }),
  };
}

/** Workday's section headings for the entries your resume has. */
const SECTION_IDS: readonly [RegExp, (resume: ResumeFacts) => number][] = [
  [/^work-experience-section$/i, (r) => r.experience.length],
  [/^education-section$/i, (r) => r.education.length],
];
/** Never add more than this many entries to one section. */
const MAX_ADDED = 10;

/** Entries to add (Add button clicks) so each section has one per entry on your resume. */
export function entriesToAdd(
  page: WorkdayPage,
  resume: ResumeFacts,
): { section: string; count: number }[] {
  return (page.sections ?? []).flatMap((section) => {
    const wanted = SECTION_IDS.find(([id]) => id.test(section.id))?.[1](resume);
    const count = Math.min((wanted ?? 0) - section.entries, MAX_ADDED);
    return count > 0 ? [{ section: section.id, count }] : [];
  });
}
