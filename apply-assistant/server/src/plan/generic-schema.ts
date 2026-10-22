import type { FieldType, FormField, FormSchema } from "./form-schema.js";
import { schemaHash } from "./form-schema.js";
import type { WorkdayPage } from "./workday-schema.js";

/**
 * Any company's own application page (no known system): the extension reads its fields
 * generically, and this gives them the shared meanings the planner answers (name, email,
 * resume, the voluntary questions...) from their labels. Everything else goes to your answer
 * bank, your remembered answers and Claude, as on every other form.
 */

type PageField = WorkdayPage["fields"][number];

/** Meanings recognised from a label, for the kinds of field they can be. */
const BY_LABEL: readonly [RegExp, string, readonly PageField["kind"][]][] = [
  [/preferred (first )?name|name you (go by|prefer)/i, "preferred_name", ["text"]],
  [/^(legal )?first name|given name|^first$/i, "first_name", ["text"]],
  [/last name|surname|family name|^last$/i, "last_name", ["text"]],
  [/^(your |full |legal )?(full )?name$/i, "full_name", ["text"]],
  [/e-?mail/i, "email", ["text"]],
  [/phone|mobile( number)?$|contact number/i, "phone", ["text"]],
  [/cover letter/i, "cover_letter", ["file"]],
  [/resume|résumé|\bcv\b|curriculum/i, "resume", ["file"]],
  [/gender|\bsex\b/i, "gender", ["dropdown", "radio", "search"]],
  [/\brace\b|ethnicit/i, "race", ["dropdown", "radio", "search"]],
  [/veteran/i, "veteran_status", ["dropdown", "radio", "search"]],
  [/disabilit/i, "disability_status", ["dropdown", "radio", "search"]],
  [/current (company|employer)|present employer/i, "current_company", ["text"]],
];

const DEMOGRAPHIC = new Set([
  "gender",
  "race",
  "veteran_status",
  "disability_status",
]);

function typeOf(field: PageField): FieldType {
  switch (field.kind) {
    case "textarea":
      return "textarea";
    case "file":
      return "file";
    case "dropdown":
    case "radio":
      return "select";
    case "search":
      return field.options.length ? "select" : "text";
    case "checkbox":
      return field.options.length > 1 ? "multiselect" : "select";
    default:
      return "text";
  }
}

function canonicalOf(field: PageField): string | undefined {
  const label = field.label.replace(/\*$/, "").trim();
  const found = BY_LABEL.find(
    ([pattern, , kinds]) => kinds.includes(field.kind) && pattern.test(label),
  );
  if (found) return found[1];
  // An upload without a telling label is the resume.
  return field.kind === "file" ? "resume" : undefined;
}

export function parseGenericPage(page: WorkdayPage, title: string): FormSchema {
  const fields: FormField[] = page.fields.map((f) => {
    const canonical = canonicalOf(f);
    const label = f.label.replace(/\*$/, "").trim();
    return {
      ref: f.ref,
      ...(canonical ? { canonical } : {}),
      label,
      type: typeOf(f),
      required: f.required,
      // A lone checkbox is a one-choice question ("I agree to the privacy notice").
      options: (f.kind === "checkbox" && f.options.length === 0
        ? [label]
        : f.options
      ).map((o) => {
        const text = o.replace(/\*$/, "").trim();
        return { label: text, value: text };
      }),
      section: canonical && DEMOGRAPHIC.has(canonical) ? "demographic" : "main",
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
