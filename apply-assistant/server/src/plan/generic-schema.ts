import type { FieldType, FormField, FormSchema } from "./form-schema.js";
import { schemaHash } from "./form-schema.js";
import { historyCanonicals, type UsedEntries } from "./history-blocks.js";
import type { ResumeFacts } from "./resume-facts.js";
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
  [
    /preferred (first )?name|name you (go by|prefer)/i,
    "preferred_name",
    ["text"],
  ],
  [/^(legal )?first name|given name|^first$/i, "first_name", ["text"]],
  [/last name|surname|family name|^last$/i, "last_name", ["text"]],
  [/^(your |full |legal )?(full )?name$/i, "full_name", ["text"]],
  [/e-?mail/i, "email", ["text"]],
  [/phone|mobile( number)?$|contact number/i, "phone", ["text"]],
  [/cover letter/i, "cover_letter", ["file"]],
  // A photo of you (SmartRecruiters' "Upload profile image"): never the resume, yours to add.
  [/photo|picture|profile (image|pic)|avatar|headshot|selfie/i, "attachment", ["file"]],
  [/resume|résumé|\bcv\b|curriculum/i, "resume", ["file"]],
  // Other documents (Oracle shows "Upload Attachment" on every page): never the resume again.
  [
    /attach|document|supporting|additional|portfolio|transcript|certificat|other/i,
    "attachment",
    ["file"],
  ],
  [/gender|\bsex\b/i, "gender", ["dropdown", "radio", "search"]],
  [/\brace\b|ethnicit/i, "race", ["dropdown", "radio", "search"]],
  [/veteran/i, "veteran_status", ["dropdown", "radio", "search"]],
  [/disabilit/i, "disability_status", ["dropdown", "radio", "search"]],
  [/current (company|employer)|present employer/i, "current_company", ["text"]],
  [/last (salary )?(hike|increment|raise|appraisal)/i, "last_hike", ["text", "date"]],
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

/**
 * Longer than a field name: a question that only mentions one ("If you answered Yes, provide
 * the Atlassian email you used") goes to your answers and Claude like any other question.
 */
const MAX_NAME_LENGTH = 50;

function canonicalOf(field: PageField): string | undefined {
  const label = field.label.replace(/\*$/, "").trim();
  if (field.kind !== "file" && label.length > MAX_NAME_LENGTH) return undefined;
  return BY_LABEL.find(
    ([pattern, , kinds]) => kinds.includes(field.kind) && pattern.test(label),
  )?.[1];
}

/**
 * Uploads without a telling label ("Drop or select", "Upload"): the first is the resume when
 * no upload asks for it by name; the rest are other documents, yours to pick.
 */
function uploadMeanings(fields: readonly PageField[]): (string | undefined)[] {
  const named = fields.map((f) => yourMeaning(f) ?? canonicalOf(f));
  let resume = named.includes("resume");
  return fields.map((f, i) => {
    if (named[i] || f.kind !== "file") return named[i];
    if (resume) return "attachment";
    resume = true;
    return "resume";
  });
}

/** Claude's meaning for a field (its page map), when it's one the planner answers itself. */
const MAPPED = new Set([
  "first_name",
  "last_name",
  "full_name",
  "preferred_name",
  "email",
  "phone",
  "resume",
  "cover_letter",
  "attachment",
  "current_company",
  "last_hike",
  "current_salary",
  "expected_salary",
  "street_address",
  "state",
  "postal_code",
  "country",
  "linkedin",
  "github",
  "website",
  "location",
  "skills",
]);
export const mappedMeaning = (f: PageField): string | undefined =>
  f.meaning && MAPPED.has(f.meaning) ? f.meaning : undefined;

/** Claude's meaning, when Claude mapped the page with your instruction: it comes first. */
const yourMeaning = (f: PageField): string | undefined =>
  f.meaningByYou ? mappedMeaning(f) : undefined;

/**
 * A list where the phone goes is its country code ("(+91)" beside Zoho's Mobile): it takes
 * your country, which finds "India (+91)", as on Workday; the number goes in the box beside it.
 */
function dialCode(f: PageField, canonical: string | undefined): string | undefined {
  const list = f.kind === "dropdown" || f.kind === "search";
  if (!list) return canonical;
  if (canonical === "phone") return "country";
  return !canonical && /^(phone|mobile)( (number|no\.?))?\s*\*?$/i.test(f.label.trim())
    ? "country"
    : canonical;
}

export function parseGenericPage(
  page: WorkdayPage,
  title: string,
  resume: ResumeFacts,
  /** Jobs and degrees the form's earlier pages filled (a multi-page form). */
  elsewhere?: UsedEntries,
): FormSchema {
  const meanings = uploadMeanings(page.fields);
  const history = historyCanonicals(page.fields, resume, elsewhere);
  const fields: FormField[] = page.fields.map((f, i) => {
    // Claude's page map only where the label alone says nothing.
    const canonical = dialCode(
      f,
      history.get(f.ref) ?? yourMeaning(f) ?? meanings[i] ?? mappedMeaning(f),
    );
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
      ...(f.block ? { group: f.block.heading } : {}),
      ...(f.widget ? { widget: f.widget } : {}),
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
