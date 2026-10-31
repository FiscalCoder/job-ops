/**
 * Supervision pipeline (plan §6) as a pure state machine. The background script asks
 * `nextAction` what to do, performs it (countdown, wait for you, or fill via the driver), and
 * feeds the outcome back with `reduce`. Submit is not a step: the run ends in "review", where
 * you check the form and click Submit yourself.
 */

export type ActionClass = "auto" | "confirm" | "protected";

/** A fill-plan entry as served by apply-assistant (GET /plans/:jobId). */
export interface PlanEntry {
  readonly ref: string;
  readonly label: string;
  readonly section: string;
  readonly type: string;
  readonly required: boolean;
  readonly actionClass: ActionClass;
  readonly status: "fill" | "needs-you" | "skip";
  readonly value: string | readonly string[] | null;
  readonly optionValues: readonly string[] | null;
  readonly source: string;
  readonly reason?: string;
  /** A searched list without your answer: what else to search for, in order ("Other"). */
  readonly alternatives?: readonly string[];
  /** The page's heading for the group it sits in ("Professional Experience (2)"). */
  readonly group?: string;
}

export type StepState =
  | "pending"
  | "countdown"
  | "awaiting-you"
  | "running"
  | "done"
  | "skipped"
  | "you-did-it";

export type Decision = "approved" | "edited" | "skipped" | "you-did-it";

export interface Step {
  readonly seq: number;
  readonly entry: PlanEntry;
  readonly state: StepState;
  /** What will be (or was) put in the field. */
  readonly value: string | readonly string[] | null;
  /** Why the step is waiting for you (needs-you reason, failed read-back, ...). */
  readonly note?: string;
  readonly decision?: Decision;
  readonly decidedBy?: "countdown" | "you";
  readonly result?: string;
  /** Failed fill attempts on this step; after MAX_ATTEMPTS, Approve stops retrying. */
  readonly attempts?: number;
  /** "Let Claude do it": this fill is Claude working the page, not the driver. */
  readonly operate?: boolean;
}

export type Phase = "filling" | "review" | "finished";

export interface RunState {
  readonly steps: readonly Step[];
  readonly cursor: number;
  readonly paused: boolean;
  readonly countdownSeconds: number;
  /** "Approve remaining auto": auto steps skip the countdown from here on. */
  readonly autoApproved: boolean;
  readonly phase: Phase;
  readonly outcome?: "submitted" | "aborted";
}

export type RunEvent =
  | { type: "countdown-finished" }
  | { type: "approve" }
  | { type: "approve-remaining-auto" }
  | { type: "edit"; value: string | readonly string[] }
  | { type: "skip" }
  | { type: "i-did-it"; value?: string }
  /** A field the fill couldn't set: Claude works it on the page instead. */
  | { type: "let-claude" }
  | { type: "filled"; result: string }
  | { type: "fill-failed"; reason: string }
  | { type: "pause" }
  | { type: "resume" }
  /** Fields you changed yourself while paused: kept as yours, not filled over. */
  | { type: "changed-by-you"; seqs: readonly number[] }
  | { type: "submitted" }
  | { type: "abort" };

export type NextAction =
  | { kind: "countdown"; seconds: number; step: Step }
  | { kind: "wait-for-you"; step: Step }
  | { kind: "fill"; step: Step }
  | { kind: "paused" }
  | { kind: "review" }
  | { kind: "finished" };

/** After this many failed fills, retrying the same value is pointless: edit it, do it, or skip. */
export const MAX_ATTEMPTS = 2;

/** Attaching the resume uploads it at once (M0), so it always goes last, after everything else. */
const isFile = (entry: PlanEntry) => entry.type === "file";

export function startRun(
  entries: readonly PlanEntry[],
  options: {
    countdownSeconds: number;
    resumeFirst?: boolean;
    /** Workday: a later page's steps continue the run's numbering. */
    firstSeq?: number;
  },
): RunState {
  const active = entries.filter((e) => e.status !== "skip");
  const files = active.filter(isFile);
  const others = active.filter((e) => !isFile(e));
  // The resume goes last, unless the system fills fields from it (then first, so it can't
  // overwrite what was typed).
  const ordered = options.resumeFirst
    ? [...files, ...others]
    : [...others, ...files];
  const steps = ordered.map((entry, index) => ({
    seq: (options.firstSeq ?? 1) + index,
    entry,
    state: "pending" as const,
    value: entry.value,
    ...(entry.status === "needs-you"
      ? { note: entry.reason ?? "No answer yet" }
      : {}),
  }));
  return {
    steps,
    cursor: 0,
    paused: false,
    countdownSeconds: options.countdownSeconds,
    autoApproved: false,
    phase: steps.length ? "filling" : "review",
  };
}

/** The field you chose to fill from: its ref, else its label and which of that label it is. */
export interface FillFrom {
  readonly ref: string;
  readonly label: string;
  /** 0 for the first field with this label, 1 for the second ("Employer" in each job). */
  readonly nth: number;
}

/**
 * "Fill from here": the entries from that field on, in the order a run fills them. Found by its
 * ref, else by its label (a page read again may mark fields afresh); not found, all of them.
 */
export function startingFrom(
  entries: readonly PlanEntry[],
  from: FillFrom,
  resumeFirst: boolean,
): PlanEntry[] {
  const ordered = startRun(entries, { countdownSeconds: 0, resumeFirst }).steps.map(
    (s) => s.entry,
  );
  let index = ordered.findIndex((e) => e.ref === from.ref);
  if (index < 0) {
    const same = ordered.flatMap((e, i) => (e.label === from.label ? [i] : []));
    index = same[from.nth] ?? same[0] ?? -1;
  }
  return index < 0 ? ordered : ordered.slice(index);
}

/**
 * "Fill only this section": its entries (a job or degree's heading, e.g. "Employment"), in the
 * order a run fills them. None found, none.
 */
export function onlySection(
  entries: readonly PlanEntry[],
  section: string,
  resumeFirst: boolean,
): PlanEntry[] {
  return startRun(entries, { countdownSeconds: 0, resumeFirst })
    .steps.map((s) => s.entry)
    .filter((e) => e.group === section);
}

const current = (state: RunState): Step | undefined =>
  state.steps[state.cursor];

const needsYou = (step: Step) =>
  step.entry.status === "needs-you" || step.value === null;

export function nextAction(state: RunState): NextAction {
  if (state.phase === "finished") return { kind: "finished" };
  if (state.phase === "review") return { kind: "review" };
  if (state.paused) return { kind: "paused" };
  const step = current(state);
  if (!step) return { kind: "review" };
  if (step.state === "running") return { kind: "fill", step };
  if (step.state === "awaiting-you" || needsYou(step))
    return { kind: "wait-for-you", step };
  if (step.entry.actionClass !== "auto") return { kind: "wait-for-you", step };
  const seconds = state.autoApproved ? 0 : state.countdownSeconds;
  // A 0 s countdown means "approve every action yourself".
  if (seconds === 0 && !state.autoApproved)
    return { kind: "wait-for-you", step };
  return { kind: "countdown", seconds, step };
}

const replaceStep = (state: RunState, patch: Partial<Step>): RunState => ({
  ...state,
  steps: state.steps.map((s, i) =>
    i === state.cursor ? { ...s, ...patch } : s,
  ),
});

/** Moves to the next step; after the last one the run waits for your review and Submit. */
const advance = (state: RunState): RunState => {
  const cursor = state.cursor + 1;
  return {
    ...state,
    cursor,
    phase: cursor >= state.steps.length ? "review" : "filling",
  };
};

/** Steps not filled yet that you may fill yourself meanwhile (never one being filled now). */
const OPEN_STATES: ReadonlySet<StepState> = new Set([
  "pending",
  "countdown",
  "awaiting-you",
]);

/**
 * Fields you changed while paused become yours ("you did it") and aren't filled over; the run
 * resumes at the first field still open.
 */
function keepYourChanges(state: RunState, seqs: ReadonlySet<number>): RunState {
  const steps = state.steps.map((step, index) =>
    index >= state.cursor && seqs.has(step.seq) && OPEN_STATES.has(step.state)
      ? {
          ...step,
          state: "you-did-it" as const,
          decision: "you-did-it" as const,
          decidedBy: "you" as const,
          note: undefined,
          result: "changed by you while paused",
        }
      : step,
  );
  let cursor = state.cursor;
  while (steps[cursor]?.state === "you-did-it") cursor++;
  return {
    ...state,
    steps,
    cursor,
    phase: cursor >= steps.length ? "review" : state.phase,
  };
}

/** Steps whose field shows something other than before the pause (by step number). */
export function changedSince(
  before: ReadonlyMap<number, string>,
  now: ReadonlyMap<number, string>,
): number[] {
  const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  return [...before.keys()].filter(
    (seq) => now.has(seq) && norm(before.get(seq)) !== norm(now.get(seq)),
  );
}

export function reduce(state: RunState, event: RunEvent): RunState {
  if (state.phase === "finished") return state;
  switch (event.type) {
    case "pause":
      return { ...state, paused: true };
    case "resume":
      return { ...state, paused: false };
    case "abort":
      return { ...state, phase: "finished", outcome: "aborted" };
    case "submitted":
      return { ...state, phase: "finished", outcome: "submitted" };
    case "approve-remaining-auto":
      return reduce({ ...state, autoApproved: true }, { type: "approve" });
    case "changed-by-you":
      return keepYourChanges(state, new Set(event.seqs));
    default:
      break;
  }
  if (state.phase !== "filling" || state.paused) return state;
  const step = current(state);
  if (!step) return state;

  switch (event.type) {
    case "countdown-finished": {
      const youApproveEach =
        state.countdownSeconds === 0 && !state.autoApproved;
      if (step.entry.actionClass !== "auto" || needsYou(step) || youApproveEach)
        return state;
      return replaceStep(state, {
        state: "running",
        decision: "approved",
        decidedBy: "countdown",
      });
    }
    case "approve":
      if (
        needsYou(step) ||
        step.state === "running" ||
        (step.attempts ?? 0) >= MAX_ATTEMPTS
      )
        return state;
      return replaceStep(state, {
        state: "running",
        decision: "approved",
        decidedBy: "you",
      });
    case "edit":
      return replaceStep(state, {
        state: "running",
        value: event.value,
        decision: "edited",
        decidedBy: "you",
        note: undefined,
        attempts: 0,
      });
    case "skip":
      return advance(
        replaceStep(state, {
          state: "skipped",
          decision: "skipped",
          decidedBy: "you",
          result: "skipped",
        }),
      );
    case "let-claude":
      // Any step waiting (for you, or its countdown), with or without an answer; never a file.
      if (
        !["pending", "countdown", "awaiting-you"].includes(step.state) ||
        step.entry.type === "file"
      )
        return state;
      return replaceStep(state, {
        state: "running",
        operate: true,
        decision: "approved",
        decidedBy: "you",
      });
    case "i-did-it":
      return advance(
        replaceStep(state, {
          state: "you-did-it",
          decision: "you-did-it",
          decidedBy: "you",
          value: event.value ?? step.value,
          result: "filled by you",
        }),
      );
    case "filled":
      if (step.state !== "running") return state;
      return advance(
        replaceStep(state, {
          state: "done",
          result: event.result,
          note: undefined,
        }),
      );
    case "fill-failed":
      if (step.state !== "running") return state;
      return replaceStep(state, {
        state: "awaiting-you",
        note: event.reason,
        result: event.reason,
        attempts: (step.attempts ?? 0) + 1,
        operate: false,
      });
    default:
      return state;
  }
}

/** Short, non-identifying form of a value for the run log on the server. */
export function maskValue(value: Step["value"]): string | null {
  if (value === null) return null;
  const text = Array.isArray(value) ? value.join(", ") : (value as string);
  if (text.length <= 2) return "**";
  return `${text[0]}***(${text.length})`;
}
