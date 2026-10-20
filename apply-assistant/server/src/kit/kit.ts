import { BANK_KEYS } from "../bank/catalogue.js";
import type { FillPlan } from "../plan/planner.js";
import type { ResumeFacts } from "../plan/resume-facts.js";

/**
 * The apply kit: every answer a person needs to fill an application by hand, grouped for the
 * side panel (APPLY_TRACE_AND_KIT_PLAN.md §T2). Built from the answer bank, the Job Ops design
 * resume, the job, and the job's stored fill plan when there is one.
 */

export interface KitItem {
  /** Stable id for recording which item filled which field ("bank:work.notice_period", ...). */
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Date of birth and voluntary (EEO) answers: shown collapsed until opened. */
  readonly sensitive?: boolean;
}

export interface KitGroup {
  readonly name: string;
  readonly items: readonly KitItem[];
}

export interface KitJob {
  readonly jobId: string;
  readonly title: string;
  readonly employer: string;
  readonly location: string | null;
  /** Where to apply: the matched posting, else Job Ops' application link, else the listing. */
  readonly applyUrl: string;
  readonly tailoredSummary: string | null;
}

export interface Kit {
  readonly job: KitJob;
  readonly groups: readonly KitGroup[];
}

export interface KitInput {
  readonly job: KitJob;
  readonly resume: ResumeFacts;
  readonly bank: ReadonlyMap<string, string>;
  readonly plan: FillPlan | null;
}

/** Answer-bank keys shown under "Work and location", in this order. */
const WORK_KEYS = [
  "location.current_city",
  "location.state",
  "location.current_country",
  "work.authorized_countries",
  "work.preferred_cities",
  "work.relocation",
  "work.notice_period",
  "work.earliest_start_date",
  "profile.years_experience",
  "profile.languages",
  "comp.current",
  "comp.expected",
  "history.worked_at_company",
  "misc.heard_about",
] as const;

/** Shown only when opened: date of birth and the voluntary disclosures. */
const isSensitive = (key: string) =>
  key === "identity.date_of_birth" || key.startsWith("eeo.");

/** Plan entries from these sources repeat what the other groups already show. */
const COVERED_SOURCES = ["bank:identity.", "resume:", "jobops:"];

const defs = new Map(BANK_KEYS.map((d) => [d.key, d]));

const item = (
  key: string,
  label: string,
  value: string | null | undefined,
  sensitive = false,
): KitItem | null => {
  const text = value?.trim();
  if (!text) return null;
  return { key, label, value: text, ...(sensitive ? { sensitive } : {}) };
};

const present = (items: readonly (KitItem | null)[]): KitItem[] =>
  items.filter((i): i is KitItem => i !== null);

const bankItem = (bank: ReadonlyMap<string, string>, key: string) =>
  item(`bank:${key}`, defs.get(key)?.label ?? key, bank.get(key));

const years = (from: number | null, to: number | null) =>
  from && to ? `${from}–${to}` : String(to ?? from ?? "");

function youGroup(input: KitInput): KitGroup {
  const { bank, resume } = input;
  const first = bank.get("identity.first_name")?.trim() ?? "";
  const last = bank.get("identity.last_name")?.trim() ?? "";
  return {
    name: "You",
    items: present([
      item(
        "you:full_name",
        "Full name",
        [first, last].filter(Boolean).join(" "),
      ),
      bankItem(bank, "identity.first_name"),
      bankItem(bank, "identity.last_name"),
      item(
        "bank:identity.preferred_name",
        "Preferred first name",
        bank.get("identity.preferred_name") || first,
      ),
      item("resume:email", "Email", resume.email),
      item("resume:phone", "Phone", resume.phone),
    ]),
  };
}

function linksGroup({ resume }: KitInput): KitGroup {
  return {
    name: "Links",
    items: present([
      item("resume:linkedin", "LinkedIn", resume.links.linkedin),
      item("resume:github", "GitHub", resume.links.github),
      item("resume:website", "Website / portfolio", resume.links.website),
    ]),
  };
}

function workGroup({ bank, resume }: KitInput): KitGroup {
  const latest = resume.experience[0];
  return {
    name: "Work and location",
    items: present([
      item(
        "resume:current_company",
        "Current / latest employer",
        latest?.company,
      ),
      item("resume:current_title", "Current / latest title", latest?.title),
      ...WORK_KEYS.map((key) => bankItem(bank, key)),
    ]),
  };
}

function educationGroup({ resume }: KitInput): KitGroup {
  const latest = [...resume.education].sort(
    (a, b) =>
      (b.level ? 1 : 0) - (a.level ? 1 : 0) ||
      (b.endYear ?? 0) - (a.endYear ?? 0),
  )[0];
  if (!latest) return { name: "Education", items: [] };
  return {
    name: "Education",
    items: present([
      item("resume:education.school", "School / university", latest.school),
      item("resume:education.degree", "Degree", latest.degree),
      item("resume:education.area", "Field of study", latest.area),
      item(
        "resume:education.years",
        "Years",
        years(latest.startYear, latest.endYear),
      ),
    ]),
  };
}

const planValue = (value: string | readonly string[] | null) =>
  value === null
    ? null
    : Array.isArray(value)
      ? value.join(", ")
      : (value as string);

function thisJobGroup({ job, plan, bank }: KitInput): KitGroup {
  const shownElsewhere = (e: FillPlan["entries"][number]) =>
    COVERED_SOURCES.some((s) => e.source.startsWith(s)) ||
    (e.bankKey !== undefined &&
      (isSensitive(e.bankKey) || planValue(e.value) === bank.get(e.bankKey)));
  const fromPlan = (plan?.entries ?? [])
    .filter(
      (e) => e.status === "fill" && e.type !== "file" && !shownElsewhere(e),
    )
    .map((e) => item(`plan:${e.ref}`, e.label, planValue(e.value)));
  return {
    name: "This job",
    items: present([
      item("jobops:tailored_summary", "Tailored summary", job.tailoredSummary),
      ...fromPlan,
    ]),
  };
}

function sensitiveGroup({ bank }: KitInput): KitGroup {
  return {
    name: "Sensitive",
    items: present(
      BANK_KEYS.filter((d) => isSensitive(d.key)).map((d) =>
        item(`bank:${d.key}`, d.label, bank.get(d.key), true),
      ),
    ),
  };
}

export function buildKit(input: KitInput): Kit {
  return {
    job: input.job,
    groups: [
      youGroup(input),
      linksGroup(input),
      workGroup(input),
      educationGroup(input),
      thisJobGroup(input),
      sensitiveGroup(input),
    ].filter((g) => g.items.length > 0),
  };
}
