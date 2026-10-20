import { bankKeyDef, isProtectedKey, splitList } from "../bank/catalogue.js";
import type { ClaudeAnswer } from "../claude/questions.js";
import { formatBankValue } from "./bank-format.js";
import { type ActionClass, classifyField, type FieldRule } from "./classify.js";
import { countryOf } from "./country.js";
import type { FieldType, FormField, FormSchema } from "./gh-schema.js";
import { findDeclineOption, pickOption, pickOptions } from "./options.js";
import type { DegreeLevel, ResumeFacts } from "./resume-facts.js";

/**
 * Builds a fill plan: for every field, the proposed value, where it came from, its action class
 * (how it is gated during the supervised run) and whether it needs you. Plain code decides
 * everything it can; questions it doesn't recognise use Claude's checked answers when given
 * (always gated on your click). Nothing is guessed: a missing answer becomes "needs you".
 */

export type EntryStatus = "fill" | "needs-you" | "skip";

export interface PlanEntry {
  readonly ref: string;
  readonly label: string;
  readonly section: FormField["section"];
  readonly type: FieldType;
  readonly required: boolean;
  readonly actionClass: ActionClass;
  readonly status: EntryStatus;
  /** What to type, or the chosen option labels for selects. */
  readonly value: string | readonly string[] | null;
  /** Greenhouse option values for selects (what the form submits). */
  readonly optionValues: readonly string[] | null;
  readonly source: string;
  readonly reason?: string;
  readonly bankKey?: string;
}

export interface PlanSummary {
  readonly fill: number;
  readonly auto: number;
  readonly confirm: number;
  readonly protected: number;
  readonly needsYou: number;
  readonly skipped: number;
  readonly estMinutes: number;
}

export interface FillPlan {
  readonly schemaHash: string;
  readonly jobCountry: string | null;
  readonly entries: readonly PlanEntry[];
  readonly summary: PlanSummary;
}

export interface PlanInput {
  readonly schema: FormSchema;
  readonly resume: ResumeFacts;
  readonly bank: ReadonlyMap<string, string>;
  /** Job Ops' location text, used when the Greenhouse posting's location names no country. */
  readonly jobLocation?: string | null;
  /** Claude's answers to unrecognised questions, by field ref (see claude/answerer.ts). */
  readonly claude?: ReadonlyMap<string, ClaudeAnswer>;
  /** Why there are no Claude answers (no key, or the call failed), shown on those questions. */
  readonly claudeProblem?: string;
}

interface Resolved {
  readonly value: string | readonly string[] | null;
  readonly source: string;
  readonly reason?: string;
  readonly bankKey?: string;
  /** Equivalent phrasings to try against a select's choices ("1 month" for 30 days). */
  readonly alternatives?: readonly string[];
  /** For selects: an option already chosen by the rule (decline / consent). */
  readonly option?: { label: string; value: string };
  /** Overrides the field's class (a Claude answer that points to a protected saved answer). */
  readonly actionClass?: ActionClass;
}

const DEGREE_LABEL: Record<DegreeLevel, string> = {
  high_school: "High School",
  associate: "Associate's Degree",
  bachelor: "Bachelor's Degree",
  master: "Master's Degree",
  doctorate: "Doctorate",
};

const AFFIRMATIVE =
  /^(yes|i agree|agree|i confirm|confirm|i acknowledge|acknowledge|i accept|accept|i understand|i certify|i have read)/i;

const missing = (
  source: string,
  reason: string,
  bankKey?: string,
): Resolved => ({
  value: null,
  source,
  reason,
  ...(bankKey ? { bankKey } : {}),
});

function fromBank(
  key: string,
  stored: string,
  field: FormField,
  jobCountry: string | null,
  bankKey: string,
): Resolved {
  const formatted = formatBankValue(
    bankKeyDef(key)?.kind ?? "text",
    stored,
    field,
    jobCountry,
  );
  if ("needsYou" in formatted)
    return missing(`bank:${key}`, formatted.needsYou, bankKey);
  return {
    value: formatted.value,
    alternatives: formatted.alternatives,
    source: `bank:${key}`,
    bankKey,
  };
}

function resolveBank(
  rule: { key: string; fallbackKey?: string },
  bank: PlanInput["bank"],
  field: FormField,
  jobCountry: string | null,
): Resolved {
  const own = bank.get(rule.key)?.trim();
  if (own) return fromBank(rule.key, own, field, jobCountry, rule.key);
  const fallback = rule.fallbackKey
    ? bank.get(rule.fallbackKey)?.trim()
    : undefined;
  if (fallback && rule.fallbackKey)
    return fromBank(rule.fallbackKey, fallback, field, jobCountry, rule.key);
  return missing(
    `bank:${rule.key}`,
    "No saved answer in your answer bank",
    rule.key,
  );
}

function resolveProfile(fact: string, resume: ResumeFacts): Resolved {
  const recent = resume.experience[0];
  const values: Record<string, string | null | undefined> = {
    email: resume.email,
    phone: resume.phone,
    linkedin: resume.links.linkedin,
    github: resume.links.github,
    website: resume.links.website ?? resume.links.linkedin,
    recent_employer: recent?.company,
    recent_title: recent?.title,
  };
  const value = values[fact];
  return value
    ? { value, source: `resume:${fact}` }
    : missing(`resume:${fact}`, "Not on your Job Ops resume");
}

function resolveWorkAuth(
  ask: "authorized" | "sponsorship",
  input: PlanInput,
  jobCountry: string | null,
): Resolved {
  const key = "work.authorized_countries";
  const countries = splitList(input.bank.get(key) ?? "");
  if (countries.length === 0)
    return missing(
      `bank:${key}`,
      "Add the countries you can work in without sponsorship",
      key,
    );
  if (!jobCountry)
    return missing(`bank:${key}`, "Couldn't tell which country this job is in");
  const authorized = countries.some(
    (c) =>
      countryOf(c) === jobCountry ||
      c.toLowerCase() === jobCountry.toLowerCase(),
  );
  const yes = ask === "authorized" ? authorized : !authorized;
  return {
    value: yes ? "Yes" : "No",
    source: `bank:${key} (job in ${jobCountry})`,
    bankKey: key,
  };
}

/** Country names (or US / UK / UAE), not cities: "Bengaluru" names a city, not India. */
const COUNTRY_SHORT = new Set([
  "us",
  "usa",
  "uk",
  "uae",
  "united states of america",
]);
const placeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/^the /, "")
    .replace(/[^a-z ]/g, "")
    .trim();

function asCountry(place: string): string | null {
  const country = countryOf(place);
  return country &&
    (placeName(place) === placeName(country) ||
      COUNTRY_SHORT.has(placeName(place)))
    ? country
    : null;
}

/**
 * "Are you located in <place>?": Yes when it's your saved country, city or state; No only when
 * it's clearly another country. Anything else (a region, another city) goes to Claude.
 */
function resolveLocatedIn(
  place: string,
  field: FormField,
  input: PlanInput,
  jobCountry: string | null,
): Resolved {
  const key = "location.current_country";
  const country = input.bank.get(key)?.trim() ?? "";
  const city = input.bank.get("location.current_city")?.trim() ?? "";
  const state = input.bank.get("location.state")?.trim() ?? "";
  if (!country && !city)
    return missing(`bank:${key}`, "Add your current country and city", key);
  const source = `bank:location (asked about ${place})`;
  const asked = asCountry(place);
  const mine = country ? countryOf(country) : null;
  if (asked && mine)
    return { value: asked === mine ? "Yes" : "No", source, bankKey: key };
  if ([city, state].some((v) => v && placeName(v) === placeName(place)))
    return { value: "Yes", source, bankKey: "location.current_city" };
  return resolveClaude(field, input, jobCountry);
}

function resolveEducation(
  part: "school" | "degree" | "discipline",
  resume: ResumeFacts,
): Resolved {
  const top = resume.education[0];
  if (!top)
    return missing("resume:education", "No education on your Job Ops resume");
  const value =
    part === "school"
      ? top.school
      : part === "degree"
        ? top.level
          ? DEGREE_LABEL[top.level]
          : top.degree
        : top.area;
  return value
    ? { value, source: `resume:education.${part}` }
    : missing("resume:education", `No ${part} on your resume`);
}

function resolveRule(
  rule: FieldRule,
  field: FormField,
  input: PlanInput,
  jobCountry: string | null,
): Resolved | "skip" {
  switch (rule.kind) {
    case "hidden":
      return "skip";
    case "bank":
      return resolveBank(rule, input.bank, field, jobCountry);
    case "full-name": {
      const first = input.bank.get("identity.first_name")?.trim();
      const last = input.bank.get("identity.last_name")?.trim();
      return first
        ? {
            value: [first, last].filter(Boolean).join(" "),
            source: "bank:identity.first_name+last_name",
            bankKey: "identity.first_name",
          }
        : missing(
            "bank:identity.first_name",
            "No saved answer in your answer bank",
            "identity.first_name",
          );
    }
    case "profile":
      return resolveProfile(rule.fact, input.resume);
    case "work-auth":
      return resolveWorkAuth(rule.ask, input, jobCountry);
    case "resume-file":
      return {
        value: "Tailored resume (PDF from Job Ops)",
        source: "jobops:tailored-pdf",
      };
    case "cover-letter":
      return field.required
        ? missing("draft", "A cover letter is required")
        : "skip";
    case "education":
      return resolveEducation(rule.part, input.resume);
    case "consent": {
      const option =
        field.options.length === 1
          ? field.options[0]
          : field.options.find((o) => AFFIRMATIVE.test(o.label.trim()));
      return option
        ? { value: option.label, source: "rule:consent", option }
        : missing("rule:consent", "No 'agree' choice found");
    }
    case "eeo": {
      const saved = input.bank.get(rule.key)?.trim();
      if (saved)
        return { value: saved, source: `bank:${rule.key}`, bankKey: rule.key };
      const decline = findDeclineOption(field.options);
      return decline
        ? {
            value: decline.label,
            source: "rule:decline-to-answer",
            option: decline,
          }
        : missing(
            `bank:${rule.key}`,
            "No 'decline to answer' choice; pick an answer",
            rule.key,
          );
    }
    case "located-in":
      return resolveLocatedIn(rule.place, field, input, jobCountry);
    case "question":
      return resolveClaude(field, input, jobCountry);
  }
}

/** Below this, Claude's answer is shown as a suggestion and the field waits for you. */
const MIN_CONFIDENCE = 0.5;
const percent = (confidence: number) => `${Math.round(confidence * 100)}%`;
const shortModel = (model: string) =>
  model.replace(/^claude-/, "").replace(/-\d.*$/, "");

function resolveClaude(
  field: FormField,
  input: PlanInput,
  jobCountry: string | null,
): Resolved {
  const answer = input.claude?.get(field.ref);
  if (!answer)
    return missing(
      "question",
      input.claudeProblem ?? "No saved answer for this question yet",
    );
  const by = `claude:${shortModel(answer.model)}`;
  switch (answer.kind) {
    case "unknown":
      return missing(by, `Claude: ${answer.why}`);
    case "bank": {
      const resolved = resolveBank(
        { key: answer.key },
        input.bank,
        field,
        jobCountry,
      );
      return {
        ...resolved,
        source: `${by} → bank:${answer.key} (${percent(answer.confidence)})`,
        actionClass: isProtectedKey(answer.key) ? "protected" : "confirm",
      };
    }
    case "answer": {
      const shown = Array.isArray(answer.value)
        ? answer.value.join(", ")
        : answer.value;
      return answer.confidence < MIN_CONFIDENCE
        ? missing(
            by,
            `Claude's unsure guess (${percent(answer.confidence)}): ${shown}. ${answer.why}`,
          )
        : {
            value: answer.value,
            source: `${by} (${percent(answer.confidence)}): ${answer.why}`,
          };
    }
    case "draft":
      return { value: answer.value, source: `${by} draft` };
  }
}

interface Typed {
  readonly status: EntryStatus;
  readonly value: PlanEntry["value"];
  readonly optionValues: PlanEntry["optionValues"];
  readonly reason?: string;
}

/** Fits a resolved value to the field type (option matching for selects). */
function fitToField(field: FormField, resolved: Resolved): Typed {
  const { value } = resolved;
  if (value === null)
    return {
      status: "needs-you",
      value: null,
      optionValues: null,
      reason: resolved.reason ?? "No answer",
    };
  if (field.type === "unknown")
    return {
      status: "needs-you",
      value,
      optionValues: null,
      reason: "This field type isn't supported yet",
    };

  if (field.type === "select") {
    if (resolved.option)
      return {
        status: "fill",
        value: resolved.option.label,
        optionValues: [resolved.option.value],
      };
    const text = Array.isArray(value) ? (value[0] ?? "") : (value as string);
    if (field.options.length === 0)
      return { status: "fill", value: text, optionValues: null };
    const option = [text, ...(resolved.alternatives ?? [])]
      .map((candidate) => pickOption(field.options, candidate))
      .find((found) => found !== null);
    return option
      ? { status: "fill", value: option.label, optionValues: [option.value] }
      : {
          status: "needs-you",
          value: text,
          optionValues: null,
          reason: `Your answer "${text}" matches none of the form's choices`,
        };
  }

  if (field.type === "multiselect") {
    const wanted = Array.isArray(value) ? value : splitList(value as string);
    const { picked, missing: unplaced } = pickOptions(field.options, wanted);
    if (picked.length === 0)
      return {
        status: "needs-you",
        value: wanted,
        optionValues: null,
        reason: "None of your answers match the form's choices",
      };
    return {
      status: "fill",
      value: picked.map((o) => o.label),
      optionValues: picked.map((o) => o.value),
      ...(unplaced.length
        ? { reason: `Not offered by the form: ${unplaced.join(", ")}` }
        : {}),
    };
  }

  return {
    status: "fill",
    value: Array.isArray(value) ? value.join(", ") : value,
    optionValues: null,
  };
}

function planField(
  field: FormField,
  input: PlanInput,
  jobCountry: string | null,
): PlanEntry {
  const { rule, actionClass } = classifyField(field);
  const base = {
    ref: field.ref,
    label: field.label,
    section: field.section,
    type: field.type,
    required: field.required,
    actionClass,
  };
  const resolved = resolveRule(rule, field, input, jobCountry);
  if (resolved === "skip")
    return {
      ...base,
      status: "skip",
      value: null,
      optionValues: null,
      source: rule.kind,
      reason: rule.kind === "hidden" ? "Filled by the page" : "Optional",
    };

  const typed = fitToField(field, resolved);
  const finalClass = resolved.actionClass ?? actionClass;
  // An optional field we can't answer is left empty rather than asking you.
  const status =
    typed.status === "needs-you" && !field.required ? "skip" : typed.status;
  return {
    ...base,
    actionClass: finalClass,
    status,
    value: typed.value,
    optionValues: typed.optionValues,
    source: resolved.source,
    ...(typed.reason ? { reason: typed.reason } : {}),
    ...(resolved.bankKey ? { bankKey: resolved.bankKey } : {}),
  };
}

const MINUTES = { base: 1, needsYou: 0.75, confirm: 0.15, auto: 0.05 };

function summarise(entries: readonly PlanEntry[]): PlanSummary {
  const filled = entries.filter((e) => e.status === "fill");
  const count = (cls: ActionClass) =>
    filled.filter((e) => e.actionClass === cls).length;
  const needsYou = entries.filter((e) => e.status === "needs-you").length;
  const confirm = count("confirm");
  const auto = count("auto");
  const estMinutes =
    MINUTES.base +
    needsYou * MINUTES.needsYou +
    (confirm + count("protected")) * MINUTES.confirm +
    auto * MINUTES.auto;
  return {
    fill: filled.length,
    auto,
    confirm,
    protected: count("protected"),
    needsYou,
    skipped: entries.filter((e) => e.status === "skip").length,
    estMinutes: Math.round(estMinutes * 10) / 10,
  };
}

/**
 * Greenhouse's phone input has its own Country dropdown that the API doesn't list. It must be
 * set before the number (M0), so it is planned right before the phone, from your bank.
 */
const PHONE_COUNTRY: FormField = {
  ref: "country",
  label: "Phone country",
  type: "select",
  required: false,
  options: [],
  section: "main",
};

const withPhoneCountry = (fields: readonly FormField[]): FormField[] =>
  fields.flatMap((field) =>
    field.ref === "phone" && !fields.some((f) => f.ref === "country")
      ? [PHONE_COUNTRY, field]
      : [field],
  );

export function buildPlan(input: PlanInput): FillPlan {
  const jobCountry =
    countryOf(input.schema.location) ?? countryOf(input.jobLocation ?? "");
  const fields = input.schema.phoneCountry
    ? withPhoneCountry(input.schema.fields)
    : input.schema.fields;
  const entries = fields.map((field) => planField(field, input, jobCountry));
  return {
    schemaHash: input.schema.hash,
    jobCountry,
    entries,
    summary: summarise(entries),
  };
}
