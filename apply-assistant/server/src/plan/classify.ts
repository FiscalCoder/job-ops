import { bankKeyDef, isProtectedKey } from "../bank/catalogue.js";
import type { FormField } from "./gh-schema.js";

/**
 * Decides where each form field's answer comes from: plain rules on Greenhouse's stable field
 * names and on the question text. Anything not recognised is a "question" for the question
 * map / model step, or for you.
 */

export type ProfileFact =
  | "email"
  | "phone"
  | "linkedin"
  | "github"
  | "website"
  | "recent_employer"
  | "recent_title";

export type FieldRule =
  | { kind: "bank"; key: string; fallbackKey?: string }
  /** One "Name" field (Ashby): first and last name from the bank. */
  | { kind: "full-name" }
  | { kind: "profile"; fact: ProfileFact }
  | { kind: "work-auth"; ask: "authorized" | "sponsorship" }
  | { kind: "resume-file" }
  | { kind: "cover-letter" }
  | { kind: "education"; part: "school" | "degree" | "discipline" }
  | { kind: "consent" }
  | { kind: "eeo"; key: string }
  /** A Yes/No "Are you located in <place>?": answered from your saved location. */
  | { kind: "located-in"; place: string }
  | { kind: "hidden" }
  | { kind: "question" };

export type ActionClass = "auto" | "confirm" | "protected";

export interface Classification {
  readonly rule: FieldRule;
  readonly actionClass: ActionClass;
}

const bank = (key: string): FieldRule => ({ kind: "bank", key });
const profile = (fact: ProfileFact): FieldRule => ({ kind: "profile", fact });

const BY_REF: Record<string, FieldRule> = {
  first_name: bank("identity.first_name"),
  full_name: { kind: "full-name" },
  last_name: bank("identity.last_name"),
  preferred_name: {
    kind: "bank",
    key: "identity.preferred_name",
    fallbackKey: "identity.first_name",
  },
  email: profile("email"),
  country: bank("location.current_country"),
  phone: profile("phone"),
  resume: { kind: "resume-file" },
  cover_letter: { kind: "cover-letter" },
  gender: { kind: "eeo", key: "eeo.gender" },
  race: { kind: "eeo", key: "eeo.race" },
  hispanic_ethnicity: { kind: "eeo", key: "eeo.race" },
  veteran_status: { kind: "eeo", key: "eeo.veteran" },
  disability_status: { kind: "eeo", key: "eeo.disability" },
  "school--0": { kind: "education", part: "school" },
  "degree--0": { kind: "education", part: "degree" },
  "discipline--0": { kind: "education", part: "discipline" },
  location: bank("location.current_city"),
  // Shared names other systems' parsers give their standard fields (Ashby, Lever).
  linkedin: profile("linkedin"),
  github: profile("github"),
  website: profile("website"),
  current_company: profile("recent_employer"),
  // Extra links (Lever): never filled with your website again; required ones go to Claude/you.
  other_link: { kind: "question" },
  twitter: { kind: "question" },
};

const CONSENT_VERB =
  /\b(agree|consent|acknowledge|certify|confirm|understand|accept)\b/;
const CONSENT_OBJECT =
  /(privacy|personal data|data protection|processing|notice|policy|terms|true|accurate|correct|complete)/;

/** Ordered label rules: the first match wins. */
const LABEL_RULES: readonly [RegExp, FieldRule][] = [
  [/sponsor/, { kind: "work-auth", ask: "sponsorship" }],
  [
    /(authori[sz]ed to work|work authori[sz]ation|legally (authori[sz]ed|eligible|allowed|permitted)|right to work|eligible to work|work permit)/,
    { kind: "work-auth", ask: "authorized" },
  ],
  [/(date of birth|\bdob\b|birth ?date)/, bank("identity.date_of_birth")],
  [
    /(preferred (first )?name|name (you'?d|you would) (prefer|like)|prefer(red)? to be called|what should we call you)/,
    {
      kind: "bank",
      key: "identity.preferred_name",
      fallbackKey: "identity.first_name",
    },
  ],
  [/linked\s?in/, profile("linkedin")],
  [/github/, profile("github")],
  // Only labels asking for the link itself: "Do you have publications (blog posts…)?" isn't.
  [
    /^(personal )?(website|portfolio|blog)\b|(website|portfolio|blog) (url|link)|link to (your )?(personal )?(website|portfolio|blog)|personal (site|website)/,
    profile("website"),
  ],
  [
    /(cities|locations).{0,40}(available|willing|open|work)|available to work in/,
    bank("work.preferred_cities"),
  ],
  [/country/, bank("location.current_country")],
  [/^(state|province|region)\b|state of residence/, bank("location.state")],
  [
    /(\bcity\b|where .{0,20}(based|located|live|reside)|current location|^location\b)/,
    bank("location.current_city"),
  ],
  [/notice period/, bank("work.notice_period")],
  [
    /(current|present).{0,20}(salary|ctc|compensation|pay)/,
    bank("comp.current"),
  ],
  [/(salary|ctc|compensation|pay)/, bank("comp.expected")],
  [/relocat/, bank("work.relocation")],
  [
    /(start date|when can you (start|join)|earliest.{0,20}(start|join)|available to (start|join))/,
    bank("work.earliest_start_date"),
  ],
  [
    /(ever|previously|currently|formerly|before).{0,40}(employed|work(ed|ing)?) (by|at|for)\b/,
    bank("history.worked_at_company"),
  ],
  [
    /(most recent|current|latest) (employer|company)/,
    profile("recent_employer"),
  ],
  [
    /(most recent|current|latest) (job )?(title|role|position)/,
    profile("recent_title"),
  ],
  [
    /(how did you (hear|find|learn)|hear about|referral source|source of application)/,
    bank("misc.heard_about"),
  ],
  [
    /^(how many )?(total )?years of (professional |relevant |work |industry )?experience( do you have)?\??$/,
    bank("profile.years_experience"),
  ],
  [
    /languages?.{0,40}(speak|fluent)|which languages/,
    bank("profile.languages"),
  ],
  [/(gender|sex\b)/, { kind: "eeo", key: "eeo.gender" }],
  [/(race|ethnic)/, { kind: "eeo", key: "eeo.race" }],
  [/veteran/, { kind: "eeo", key: "eeo.veteran" }],
  [/disab/, { kind: "eeo", key: "eeo.disability" }],
  [/pronoun/, { kind: "eeo", key: "eeo.pronouns" }],
  [/(sexual orientation|lgbt|transgender)/, { kind: "eeo", key: "eeo.other" }],
];

/** A choice of Yes / No (optionally "Yes, …"), and nothing else. */
const isYesNo = (field: FormField): boolean =>
  (field.type === "select" || field.type === "multiselect") &&
  field.options.length >= 2 &&
  field.options.length <= 3 &&
  field.options.every((o) => /^(yes|no)\b/i.test(o.label.trim()));

const LOCATED_IN =
  /^(are|do) you (currently )?(located|based|living|live|residing|reside) (in|within) (the )?(.+?)\s*\??$/;

/** Rules that can answer a Yes/No question; the rest give a value (a city, a company name). */
function answersYesNo(rule: FieldRule): boolean {
  switch (rule.kind) {
    case "work-auth":
    case "consent":
    case "eeo":
      return true;
    case "bank":
      return bankKeyDef(rule.key)?.kind === "yesno";
    default:
      return false;
  }
}

function ruleFor(field: FormField): FieldRule {
  if (field.type === "hidden") return { kind: "hidden" };
  const byRef = BY_REF[field.canonical ?? field.ref];
  if (byRef) return byRef;

  const label = field.label.toLowerCase().replace(/’/g, "'").trim();
  const isChoice = field.type === "select" || field.type === "multiselect";
  if (isChoice && CONSENT_VERB.test(label) && CONSENT_OBJECT.test(label))
    return { kind: "consent" };
  if (isYesNo(field)) {
    const place = LOCATED_IN.exec(label)?.[6];
    if (place) return { kind: "located-in", place };
    const rule = LABEL_RULES.find(([pattern]) => pattern.test(label))?.[1];
    return rule && answersYesNo(rule) ? rule : { kind: "question" };
  }
  return (
    LABEL_RULES.find(([pattern]) => pattern.test(label))?.[1] ?? {
      kind: "question",
    }
  );
}

function actionClassFor(rule: FieldRule): ActionClass {
  switch (rule.kind) {
    case "work-auth":
      return "protected";
    case "bank":
      return isProtectedKey(rule.key) ? "protected" : "auto";
    case "consent":
    case "eeo":
    case "question":
    case "located-in":
    case "cover-letter":
      return "confirm";
    case "education":
      return rule.part === "school" ? "confirm" : "auto";
    default:
      return "auto";
  }
}

export function classifyField(field: FormField): Classification {
  const rule = ruleFor(field);
  return { rule, actionClass: actionClassFor(rule) };
}
