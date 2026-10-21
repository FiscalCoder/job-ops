import { z } from "zod";
import type { FieldType, FormField, FormSchema } from "./form-schema.js";
import { schemaHash } from "./form-schema.js";

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
};

/** Filled by Workday from your resume, or optional extras: left to Workday and you. */
const LEFT_ALONE =
  /^(legalName--\w+Local|legalName--middleName|preferredCheck|extension|jobTitle|companyName|location|currentlyWorkHere|startDate|endDate|roleDescription|schoolName|school|degree|fieldOfStudy|gradeAverage|firstYearAttended|lastYearAttended|skills|websites?|url|linkedInAccount|certification\w*|language\w*)$/;

/** Fields inside a repeated section (work history, education, ...) are Workday's to fill. */
const REPEATED = /^(workExperience|education|certification|language|website)-/i;

function typeOf(field: PageField): FieldType {
  if (REPEATED.test(field.ref) || field.kind === "date") return "hidden";
  if (LEFT_ALONE.test(field.key) && !CANONICAL[field.key]) return "hidden";
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
  const fields: FormField[] = page.fields.map((f) => {
    const type = typeOf(f);
    const canonical = f.kind === "file" ? "resume" : CANONICAL[f.key];
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
