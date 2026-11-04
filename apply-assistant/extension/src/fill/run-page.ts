import type { ApplyClient } from "../lib/api";
import { GenericDriver } from "./generic-driver";
import { labelKey, type SiteHelp, type SiteRecipe } from "./site-help";
import {
  type FillFrom,
  maskValue,
  onlyField,
  onlySection,
  type PlanEntry,
  type Step,
  startingFrom,
} from "./supervisor";
import type { FormDriver } from "./trusted";
import { type Chooser, type EntriesToAdd, WorkdayDriver } from "./workday-driver";

/**
 * A run's help from the server, page by page: the plan for the page on screen, Claude's picks
 * among a list's choices, this site's saved steps; and what a run logs and remembers.
 */

/** The saved steps' name for a kind of widget (any field of it, on any site). */
const WIDGET_LABEL = "Any field of this kind";

/** A form filled page by page as you reach each page: Workday, or any company's own site. */
export type PagedDriver = WorkdayDriver | GenericDriver;
export const isPaged = (driver: FormDriver): driver is PagedDriver =>
  driver instanceof WorkdayDriver || driver instanceof GenericDriver;

/** Workday's last page: nothing to fill, you check everything and submit. */
export const FINAL_STEP = /^review$/i;

/**
 * A driver's help with lists: Claude's pick among a list's choices when none is worded like
 * your answer, and broader words to search a list for when your answer's own find nothing.
 */
export function helpPicking(
  driver: WorkdayDriver | GenericDriver,
  client: ApplyClient,
  jobId: string,
): void {
  driver.chooser = chooserFor(client, jobId);
  driver.searchTerms = async (label, wanted) =>
    (await client.searchTerms(jobId, { label, wanted })).terms ?? [];
}

/** Claude picks among a list's choices when none is worded like your answer. */
function chooserFor(client: ApplyClient, jobId: string): Chooser {
  return async (label, wanted, choices) => {
    const answer = await client
      .choose(jobId, { label, wanted, options: choices })
      .catch(() => null);
    const value = answer?.value;
    return (typeof value === "string" ? value : value?.[0]) ?? null;
  };
}

/**
 * Filling the page again: from a field you chose, only one section of it, or only one field
 * ("Fix a field": filled again, or by Claude with what you said was wrong).
 */
export type PageChoice =
  | { readonly kind: "from"; readonly from: FillFrom }
  | { readonly kind: "only"; readonly section: string }
  | {
      readonly kind: "field";
      readonly field: FillFrom;
      /** Claude works it on the page, told this (what was wrong); absent, filled again as usual. */
      readonly claude?: string;
    };

export function chosen(
  entries: readonly PlanEntry[],
  choice: PageChoice,
  resumeFirst: boolean,
): PlanEntry[] {
  if (choice.kind === "field")
    return onlyField(entries, choice.field, resumeFirst);
  return choice.kind === "from"
    ? startingFrom(entries, choice.from, resumeFirst)
    : onlySection(entries, choice.section, resumeFirst);
}

export const describeChoice = (choice: PageChoice) =>
  choice.kind === "from"
    ? `from "${choice.from.label}"`
    : choice.kind === "only"
      ? `only "${choice.section}"`
      : `only the field "${choice.field.label}"${choice.claude !== undefined ? ", by Claude" : ""}`;

/** Claude's closer read of a page: its HTML; when you asked, a screenshot too. */
export type Closely = false | "html" | "html+screenshot";

/**
 * The server's plan for the page on screen. `closely`: the form's HTML goes too (and when you
 * asked, a screenshot), for Claude's closer read of the page.
 */
export async function planPagedPage(
  client: ApplyClient,
  jobId: string,
  driver: PagedDriver,
  closely: Closely = false,
  /** What you told Claude about this page (with the closer read). */
  note?: string,
  /** False while the page is being filled: no "Add" clicks of its own (a read alongside). */
  mayAdd = true,
): Promise<PlanEntry[]> {
  if (driver.system === "workday" && FINAL_STEP.test(await driver.step()))
    return [];
  type PagePlan = { entries: PlanEntry[]; add?: EntriesToAdd[]; reveal?: string[] };
  const page = await driver.readPage();
  const snapshot = closely
    ? await driver.formSnapshot(page.fields.map((f) => f.ref))
    : null;
  const screenshot =
    snapshot && closely === "html+screenshot" ? await driver.pageShot() : null;
  const plan = (await client.planPage(
    jobId,
    snapshot
      ? {
          ...page,
          snapshot,
          ...(screenshot ? { screenshot } : {}),
          ...(note ? { note } : {}),
        }
      : page,
  )) as PagePlan;
  // Fields kept behind a button (an entry's Edit, a closed section): shown, then planned again
  // (each button once per page, so this ends).
  if (
    mayAdd &&
    plan.reveal?.length &&
    driver instanceof GenericDriver &&
    (await driver.reveal(plan.reveal)) > 0
  )
    return planPagedPage(client, jobId, driver);
  // Fields Claude found in the HTML that the reader didn't: only those really on the page.
  const read = new Set(page.fields.map((f) => f.ref));
  const extra = plan.entries
    .filter((e) => !read.has(e.ref) && !e.ref.startsWith("[data-ac-ref="))
    .map((e) => e.ref);
  if (extra.length && driver instanceof GenericDriver) {
    const live = await driver.liveRefs(extra);
    // Each found by the reader's kind of mark from now on (a selector Claude wrote with
    // "host >>> inner" isn't one the page's own lookups take).
    plan.entries = plan.entries.flatMap((e) => {
      if (read.has(e.ref) || e.ref.startsWith("[data-ac-ref=")) return [e];
      const mark = live.get(e.ref);
      return mark ? [{ ...e, ref: mark }] : [];
    });
  }
  if (!plan.add?.length || !mayAdd) return plan.entries;
  // My Experience: one entry per job and degree on your resume, then the page is planned again.
  await driver.addEntries(plan.add);
  const again = (await client.planPage(
    jobId,
    await driver.readPage(),
  )) as PagePlan;
  return again.entries;
}

/** Answers from the bank, your resume or Job Ops are fixed at their source, not learned. */
const FIXED_SOURCE = /^(bank:|resume:|jobops:|rule:)/;

/** Your edit or own answer to a form question, worth reusing on the next form. */
export function learnable(step: Step): boolean {
  const { entry } = step;
  const yours =
    (step.decision === "edited" && step.state === "done") ||
    step.decision === "you-did-it";
  return (
    yours &&
    entry.type !== "file" &&
    entry.actionClass !== "protected" &&
    entry.section !== "demographic" &&
    entry.section !== "compliance" &&
    !FIXED_SOURCE.test(entry.source)
  );
}

export function toLogEntry(step: Step) {
  return {
    seq: step.seq,
    actionClass: step.entry.actionClass,
    fieldRef: step.entry.ref,
    valueMasked: maskValue(step.value),
    source: step.entry.source,
    decision: step.decision ?? "approved",
    decidedBy: step.decidedBy ?? "you",
    result: step.result ?? step.state,
  };
}

/** This site's saved steps and Claude, for fields a driver can't fill by itself. */
export async function siteHelp(
  client: ApplyClient,
  jobId: string,
  host: string,
): Promise<SiteHelp> {
  const saved = await client.recipes(host).catch(() => []);
  const recipes = new Map(saved.map((r) => [r.labelKey, r]));
  // A kind of widget's steps are kept like a site's, under "widget.<kind>" (any site).
  const widgets = new Map<string, Promise<SiteRecipe | null>>();
  const widgetHost = (kind: string) => `widget.${kind}`;
  return {
    recipes,
    widget: (kind) => {
      let found = widgets.get(kind);
      if (!found) {
        found = client
          .recipes(widgetHost(kind))
          .then((list) => list.find((r) => r.labelKey === labelKey(WIDGET_LABEL)) ?? null)
          .catch(() => null);
        widgets.set(kind, found);
      }
      return found;
    },
    recordWidget: async (kind, steps, ok) => {
      widgets.delete(kind);
      await client.recordRecipe({
        host: widgetHost(kind),
        label: WIDGET_LABEL,
        steps,
        ok,
        jobId,
      });
    },
    act: async (ask) => (await client.act(jobId, ask)).steps,
    record: async (label, steps, ok) => {
      await client.recordRecipe({ host, label, steps, ok, jobId });
      const key = labelKey(label);
      const before = recipes.get(key);
      recipes.set(key, {
        labelKey: key,
        steps: ok ? steps : (before?.steps ?? steps),
        worked: (before?.worked ?? 0) + (ok ? 1 : 0),
        failed: (before?.failed ?? 0) + (ok ? 0 : 1),
      });
    },
  };
}
