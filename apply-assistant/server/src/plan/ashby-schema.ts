import { z } from "zod";
import {
  type FieldType,
  type FormField,
  type FormSchema,
  schemaHash,
} from "./form-schema.js";

/**
 * Normalises Ashby's public application-form definition (the `ApiJobPosting` query its own
 * application page runs; the extension fetches it) into the shared field list. Field refs are
 * Ashby's `path`, which the page uses as element ids.
 */

const TYPE_MAP: Record<string, FieldType> = {
  String: "text",
  Email: "text",
  Phone: "text",
  Url: "text",
  Number: "text",
  Date: "text",
  Location: "text",
  LongText: "textarea",
  File: "file",
  ValueSelect: "select",
  MultiValueSelect: "multiselect",
  Boolean: "select",
};

/** Ashby's system fields and typed fields that mean the same as a shared (Greenhouse) name. */
const CANONICAL_BY_PATH: Record<string, string> = {
  _systemfield_name: "full_name",
  _systemfield_email: "email",
  _systemfield_resume: "resume",
  _systemfield_location: "location",
  _systemfield_phone: "phone",
  // Forms imported from Greenhouse keep its names.
  phone: "phone",
  cover_letter: "cover_letter",
};
const CANONICAL_BY_TYPE: Record<string, string> = {
  Phone: "phone",
};

/** A Location field answers with your city, or your country when it only accepts countries. */
const locationCanonical = (types: readonly string[] | null | undefined) =>
  !types || types.length === 0 || types.includes("City")
    ? "location"
    : "country";

const YES_NO = [
  { label: "Yes", value: "true" },
  { label: "No", value: "false" },
];

const entrySchema = z.object({
  field: z.object({
    path: z.string(),
    title: z.string(),
    type: z.string(),
    locationTypes: z.array(z.string()).nullable().optional(),
    selectableValues: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          isArchived: z.boolean().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
  }),
  isRequired: z.boolean().nullable().optional(),
  isHidden: z.boolean().nullable().optional(),
});

const payloadSchema = z.object({
  jobPosting: z.object({
    id: z.string(),
    title: z.string(),
    locationName: z.string().nullable().optional(),
    applicationForm: z.object({
      sections: z.array(z.object({ fieldEntries: z.array(z.unknown()) })),
    }),
  }),
});

type Entry = z.infer<typeof entrySchema>;

function toField(entry: Entry): FormField {
  const { field } = entry;
  const canonical =
    field.type === "Location"
      ? locationCanonical(field.locationTypes)
      : (CANONICAL_BY_PATH[field.path] ?? CANONICAL_BY_TYPE[field.type]);
  const options =
    field.type === "Boolean"
      ? YES_NO
      : (field.selectableValues ?? [])
          .filter((v) => v.isArchived !== true)
          .map(({ label, value }) => ({ label: label.trim(), value }));
  return {
    ref: field.path,
    ...(canonical ? { canonical } : {}),
    label: field.title.trim(),
    type: entry.isHidden ? "hidden" : (TYPE_MAP[field.type] ?? "unknown"),
    required: entry.isRequired === true,
    options,
    section: field.type === "Location" ? "location" : "main",
  };
}

export function parseAshbySchema(payload: unknown): FormSchema {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error(
      `Not an Ashby application form: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  const posting = parsed.data.jobPosting;
  // Entries that aren't plain fields (rare layout blocks) are skipped rather than failing.
  const fields = posting.applicationForm.sections
    .flatMap((section) => section.fieldEntries)
    .map((entry) => entrySchema.safeParse(entry))
    .flatMap((result) => (result.success ? [toField(result.data)] : []));

  return {
    postingId: posting.id,
    title: posting.title,
    location: posting.locationName ?? "",
    education: null,
    fields,
    hash: schemaHash({ fields }),
  };
}
