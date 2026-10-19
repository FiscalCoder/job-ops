import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Normalises Greenhouse's public `?questions=true` job payload into one flat field list the
 * planner works on. The extension fetches the payload (your IP); the server only parses it.
 */

export type FieldType =
  | "text"
  | "textarea"
  | "file"
  | "select"
  | "multiselect"
  | "hidden"
  | "unknown";

export type FieldSection =
  | "main"
  | "location"
  | "compliance"
  | "demographic"
  | "education";

export interface FieldOption {
  readonly label: string;
  readonly value: string;
}

export interface FormField {
  readonly ref: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly options: readonly FieldOption[];
  readonly section: FieldSection;
}

export interface FormSchema {
  readonly ghJobId: string;
  readonly title: string;
  readonly location: string;
  readonly education: "required" | "optional" | null;
  readonly fields: readonly FormField[];
  readonly hash: string;
}

const TYPE_MAP: Record<string, FieldType> = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
  input_hidden: "hidden",
};

/** Greenhouse pairs each file input with a "paste instead" textarea; the file is what we fill. */
const PASTE_ALTERNATIVES = new Set(["resume_text", "cover_letter_text"]);

const EDUCATION_FIELDS = [
  { ref: "school--0", label: "School" },
  { ref: "degree--0", label: "Degree" },
  { ref: "discipline--0", label: "Discipline" },
] as const;

const value = z.union([z.string(), z.number()]).transform(String);
const option = z.object({ label: z.string(), value });
const field = z.object({
  name: z.string(),
  type: z.string(),
  values: z.array(option).optional().default([]),
});
const question = z.object({
  label: z.string(),
  required: z.boolean().nullable().optional(),
  fields: z.array(field),
});
const demographicQuestion = z.object({
  id: value,
  label: z.string(),
  required: z.boolean().nullable().optional(),
  type: z.string(),
  answer_options: z
    .array(z.object({ id: value, label: z.string() }))
    .optional()
    .default([]),
});

const payloadSchema = z.object({
  id: value,
  title: z.string(),
  location: z
    .object({ name: z.string().nullable().optional() })
    .nullable()
    .optional(),
  education: z.string().nullable().optional(),
  questions: z.array(question).optional().default([]),
  location_questions: z.array(question).nullable().optional(),
  compliance: z
    .array(z.object({ questions: z.array(question).optional().default([]) }))
    .nullable()
    .optional(),
  demographic_questions: z
    .object({ questions: z.array(demographicQuestion).optional().default([]) })
    .nullable()
    .optional(),
});

type Question = z.infer<typeof question>;

const fromQuestions = (
  questions: readonly Question[],
  section: FieldSection,
): FormField[] =>
  questions.flatMap((q) =>
    q.fields
      .filter((f) => !PASTE_ALTERNATIVES.has(f.name))
      .map((f) => ({
        ref: f.name.replace(/\[\]$/, ""),
        label: q.label,
        type: TYPE_MAP[f.type] ?? "unknown",
        required: q.required === true,
        options: f.values,
        section,
      })),
  );

const educationMode = (raw: string | null | undefined) =>
  raw === "education_required"
    ? "required"
    : raw === "education_optional"
      ? "optional"
      : null;

export function parseGreenhouseSchema(payload: unknown): FormSchema {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error(
      `Not a Greenhouse job payload: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  const job = parsed.data;
  const education = educationMode(job.education);

  const fields: FormField[] = [
    ...fromQuestions(job.questions, "main"),
    ...fromQuestions(job.location_questions ?? [], "location"),
    ...EDUCATION_FIELDS.filter(() => education !== null).map((f) => ({
      ...f,
      type: "select" as const,
      required: education === "required",
      options: [],
      section: "education" as const,
    })),
    ...fromQuestions(
      (job.compliance ?? []).flatMap((c) => c.questions),
      "compliance",
    ),
    ...(job.demographic_questions?.questions ?? []).map((q) => ({
      ref: `demographic_${q.id}`,
      label: q.label,
      type: TYPE_MAP[q.type] ?? ("unknown" as const),
      required: q.required === true,
      options: q.answer_options.map((o) => ({ label: o.label, value: o.id })),
      section: "demographic" as const,
    })),
  ];

  const hash = createHash("sha256")
    .update(JSON.stringify({ education, fields }))
    .digest("hex")
    .slice(0, 16);

  return {
    ghJobId: job.id,
    title: job.title,
    location: job.location?.name ?? "",
    education,
    fields,
    hash,
  };
}
