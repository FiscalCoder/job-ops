import { z } from "zod";
import {
  type FieldOption,
  type FieldSection,
  type FieldType,
  type FormField,
  type FormSchema,
  schemaHash,
} from "./form-schema.js";

/**
 * Normalises a Lever application form into the shared field list. Lever has no form API: the
 * extension sends the posting (id, title, location) with the <form id="application-form"> of
 * its apply page, and this reads it. Custom questions carry their own JSON definition (each
 * card's hidden `baseTemplate`); standard fields are read from their labelled blocks. Refs are
 * the inputs' `name`s, which is how the driver finds them.
 */

const payloadSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  location: z.string().nullable().optional(),
  formHtml: z.string().max(2_000_000),
});

/** Standard Lever field names that mean the same as a shared name. */
const CANONICAL: Record<string, string> = {
  resume: "resume",
  name: "full_name",
  email: "email",
  phone: "phone",
  location: "location",
  org: "current_company",
  "urls[LinkedIn]": "linkedin",
  "urls[GitHub]": "github",
  "urls[Portfolio]": "website",
  // A second, free-form link: left for you rather than repeating the portfolio.
  "urls[Other]": "other_link",
  "urls[Twitter]": "twitter",
  "eeo[gender]": "gender",
  "eeo[race]": "race",
  "eeo[veteran]": "veteran_status",
  "eeo[disability]": "disability_status",
};

/** Hidden bookkeeping and things filled by the page itself. */
const IGNORED = new Set([
  "selectedLocation",
  "accountId",
  "linkedInData",
  "origin",
  "referer",
  "timezone",
  "socialReferralKey",
  "socialSource",
  "resumeStorageId",
  "h-captcha-response",
  "g-recaptcha-response",
  "source",
]);

const CARD_TYPES: Record<string, FieldType> = {
  text: "text",
  textarea: "textarea",
  "multiple-choice": "select",
  dropdown: "select",
  "multiple-select": "multiselect",
};

const ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, code: string) => {
      if (code[0] === "#")
        return String.fromCodePoint(
          code[1]?.toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10),
        );
      return ENTITIES[code.toLowerCase()] ?? whole;
    },
  );
}

const stripTags = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/✱/g, "")
    .replace(/\s+/g, " ")
    .trim();

const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? "") : null;
};

const cardTemplate = z.object({
  id: z.string(),
  deletedAt: z.number().nullable().optional(),
  fields: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().nullable().optional(),
        required: z.boolean().nullable().optional(),
        options: z
          .array(z.object({ text: z.string() }))
          .nullable()
          .optional(),
      }),
    )
    .optional()
    .default([]),
});

function cardFields(formHtml: string): FormField[] {
  const tags = formHtml.match(
    /<input\b[^>]*name="cards\[[^\]]+\]\[baseTemplate\]"[^>]*>/g,
  );
  return (tags ?? []).flatMap((tag) => {
    let card: z.infer<typeof cardTemplate>;
    try {
      card = cardTemplate.parse(JSON.parse(attr(tag, "value") ?? ""));
    } catch {
      return [];
    }
    if (card.deletedAt) return [];
    return card.fields.map((field, index) => ({
      ref: `cards[${card.id}][field${index}]`,
      label: (field.text ?? "").trim(),
      type: CARD_TYPES[field.type] ?? ("unknown" as const),
      required: field.required === true,
      options: (field.options ?? []).map((o) => ({
        label: o.text.trim(),
        value: o.text,
      })),
      section: "main" as const,
    }));
  });
}

/** One labelled block of a standard (non-card) question. */
function standardField(block: string): FormField | null {
  const controls = [
    ...block.matchAll(/<(input|textarea|select)\b([^>]*)>/gi),
  ].map((m) => ({
    tag: (m[1] ?? "").toLowerCase(),
    raw: m[0],
    name: attr(m[0], "name"),
    type: (attr(m[0], "type") ?? "").toLowerCase(),
  }));
  const control = controls.find(
    (c) =>
      c.name &&
      c.type !== "hidden" &&
      !c.name.startsWith("cards[") &&
      !IGNORED.has(c.name),
  );
  if (!control?.name) return null;
  const name = control.name;
  const labelHtml =
    /<div class="application-label[^"]*">([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
    "";
  const required =
    /class="required"/.test(labelHtml) || /\brequired\b/i.test(control.raw);

  let type: FieldType;
  let options: FieldOption[] = [];
  if (control.tag === "textarea") type = "textarea";
  else if (control.tag === "select") {
    type = "select";
    options = [
      ...block.matchAll(
        /<option\b[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi,
      ),
    ]
      .filter((m) => m[1])
      .map((m) => ({
        label: stripTags(m[2] ?? ""),
        value: decodeEntities(m[1] ?? ""),
      }));
  } else if (control.type === "radio" || control.type === "checkbox") {
    type = control.type === "radio" ? "select" : "multiselect";
    options = controls
      .filter((c) => c.name === name && c.type === control.type)
      .map((c) => {
        const value = attr(c.raw, "value") ?? "";
        return { label: value.trim(), value };
      });
  } else if (control.type === "file") type = "file";
  else type = "text";

  const canonical = CANONICAL[name];
  const section: FieldSection = name.startsWith("eeo[")
    ? "demographic"
    : name === "location"
      ? "location"
      : "main";
  return {
    ref: name,
    ...(canonical ? { canonical } : {}),
    label: stripTags(labelHtml) || name,
    type,
    required,
    options,
    section,
  };
}

function standardFields(formHtml: string): FormField[] {
  const blocks = formHtml
    .split(/(?=<(?:li|div) class="application-question)/)
    .slice(1);
  const seen = new Set<string>();
  return blocks.map(standardField).filter((field): field is FormField => {
    if (!field || seen.has(field.ref)) return false;
    seen.add(field.ref);
    return true;
  });
}

export function parseLeverSchema(payload: unknown): FormSchema {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error(
      `Not a Lever application form: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  const { id, title, location, formHtml } = parsed.data;
  if (!/<form\b[^>]*id="application-form"/.test(formHtml))
    throw new Error("Not a Lever application form: no application form found");
  const fields = [...standardFields(formHtml), ...cardFields(formHtml)];
  return {
    postingId: id,
    title,
    location: location ?? "",
    education: null,
    fields,
    hash: schemaHash({ fields }),
  };
}
