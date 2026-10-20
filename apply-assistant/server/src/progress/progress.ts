import type { Run, RunAction } from "../store/runs-repo.js";
import type { TraceEvent } from "../store/trace-store.js";

/**
 * M4 progress: the plan's success targets (PHASE1_GREENHOUSE_PLAN.md §1), measured from your
 * submitted supervised runs, their logged steps and their trails.
 */

export const TARGET_APPLICATIONS = 20;

export interface Application {
  readonly jobId: string;
  readonly runId: string;
  readonly submittedAt: string;
  readonly steps: number;
  /** Filled as planned: approved, or edited back to the same value. */
  readonly filledAsPlanned: number;
  /** You changed the answer, typed it yourself, or skipped the step. */
  readonly byYou: number;
  readonly protectedChanged: number;
  readonly minutes: number | null;
  /** Steps in the trail with no row in the run log. */
  readonly missingFromLog: number;
  /** Claude spend for this job (all plan builds and Ask Claude); null when unknown. */
  readonly cost: number | null;
}

export interface Target {
  readonly id: string;
  readonly label: string;
  readonly target: string;
  readonly value: string;
  readonly met: boolean | null;
}

export interface Progress {
  readonly applications: readonly Application[];
  readonly manualApplications: number;
  readonly targets: readonly Target[];
}

export interface ProgressInput {
  readonly runs: readonly Run[];
  readonly actionsOf: (runId: string) => readonly RunAction[];
  /** The job's trail (all its events, oldest first). */
  readonly eventsOf: (jobId: string) => readonly TraceEvent[];
  /** "You marked it Applied" events from the kit, across all jobs. */
  readonly manualApplications: number;
}

const same = (a: unknown, b: unknown) => {
  const text = (v: unknown) =>
    (Array.isArray(v) ? v.join(", ") : String(v ?? ""))
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  return text(a) === text(b);
};

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) to milliseconds. */
const toMs = (sqliteTime: string) =>
  Date.parse(`${sqliteTime.replace(" ", "T")}Z`);

interface StepView {
  readonly edited: boolean;
  readonly changed: boolean;
  /** Edited before planned values were recorded: whether it changed anything is unknown. */
  readonly unknown: boolean;
}

/** Per step: was it edited, and did the edit change the planned value? */
function editsOf(events: readonly TraceEvent[]): Map<number, StepView> {
  const views = new Map<number, StepView>();
  for (const event of events) {
    if (event.kind !== "decision" || event.stepSeq === null) continue;
    const data = (event.data ?? {}) as {
      type?: string;
      value?: unknown;
      planned?: unknown;
    };
    if (data.type !== "edit") continue;
    const prior = views.get(event.stepSeq);
    // Runs from before planned values were recorded: count any edit as a change.
    const unknown = !("planned" in data);
    const changed = unknown || !same(data.value, data.planned);
    views.set(event.stepSeq, {
      edited: true,
      changed: (prior?.changed ?? false) || changed,
      unknown: (prior?.unknown ?? false) || unknown,
    });
  }
  return views;
}

function costOf(events: readonly TraceEvent[]): number | null {
  const costs = events
    .filter((e) => e.kind === "claude-usage")
    .map((e) => (e.data as { cost?: number | null } | null)?.cost);
  if (costs.some((c) => c === null || c === undefined))
    return costs.length ? null : 0;
  return costs.reduce<number>((sum, c) => sum + (c ?? 0), 0);
}

function application(run: Run, input: ProgressInput): Application {
  const actions = input.actionsOf(run.id);
  const events = input.eventsOf(run.jobId);
  const ofRun = events.filter((e) => e.runId === run.id);
  const edits = editsOf(ofRun);
  let filledAsPlanned = 0;
  let protectedChanged = 0;
  for (const action of actions) {
    const edit = edits.get(action.seq);
    const yours =
      action.decision === "skipped" ||
      action.decision === "you-did-it" ||
      (action.decision === "edited" && (edit?.changed ?? true));
    if (!yours) filledAsPlanned += 1;
    // A wrong protected answer needs evidence: a known change, or you filling it yourself.
    const knownChange =
      action.decision === "you-did-it" ||
      (action.decision === "edited" &&
        edit !== undefined &&
        edit.changed &&
        !edit.unknown);
    if (action.actionClass === "protected" && knownChange)
      protectedChanged += 1;
  }
  const logged = new Set(actions.map((a) => a.seq));
  const traced = new Set(
    ofRun
      .filter(
        (e) =>
          e.stepSeq !== null &&
          (e.kind === "step-filled" ||
            e.kind === "step-failed" ||
            e.kind === "decision"),
      )
      .map((e) => e.stepSeq as number),
  );
  const minutes =
    run.endedAt === null
      ? null
      : Math.round(((toMs(run.endedAt) - toMs(run.startedAt)) / 60_000) * 10) /
        10;
  return {
    jobId: run.jobId,
    runId: run.id,
    submittedAt: run.endedAt ?? run.startedAt,
    steps: actions.length,
    filledAsPlanned,
    byYou: actions.length - filledAsPlanned,
    protectedChanged,
    minutes,
    missingFromLog: [...traced].filter((seq) => !logged.has(seq)).length,
    cost: costOf(events),
  };
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

export function computeProgress(input: ProgressInput): Progress {
  // One application per job: before runs on applied jobs were refused, reopening a posting
  // could log its confirmation page as another "submitted" run.
  const firstSubmitted = new Map<string, Run>();
  for (const run of input.runs)
    if (run.outcome === "submitted" && !firstSubmitted.has(run.jobId))
      firstSubmitted.set(run.jobId, run);
  const applications = [...firstSubmitted.values()].map((r) =>
    application(r, input),
  );
  const none = applications.length === 0;
  const steps = applications.reduce((n, a) => n + a.steps, 0);
  const asPlanned = applications.reduce((n, a) => n + a.filledAsPlanned, 0);
  const share = steps ? asPlanned / steps : null;
  const protectedChanged = applications.reduce(
    (n, a) => n + a.protectedChanged,
    0,
  );
  const minutes = median(
    applications.flatMap((a) => (a.minutes === null ? [] : [a.minutes])),
  );
  const missing = applications.reduce((n, a) => n + a.missingFromLog, 0);
  const costs = applications.flatMap((a) => (a.cost === null ? [] : [a.cost]));
  const meanCost = costs.length
    ? costs.reduce((s, c) => s + c, 0) / costs.length
    : null;

  const targets: Target[] = [
    {
      id: "applications",
      label: "Supervised applications submitted",
      target: `${TARGET_APPLICATIONS}`,
      value: `${applications.length}`,
      met: applications.length >= TARGET_APPLICATIONS,
    },
    {
      id: "protected",
      label:
        "Wrong answers to protected questions (sponsorship, authorisation, CTC, notice)",
      target: "0",
      value: `${protectedChanged}`,
      met: none ? null : protectedChanged === 0,
    },
    {
      id: "as-planned",
      label: "Fields filled without you changing them",
      target: "≥ 85%",
      value: share === null ? "–" : `${Math.round(share * 100)}%`,
      met: share === null ? null : share >= 0.85,
    },
    {
      id: "time",
      label: "Median time per application, including your review",
      target: "≤ 3 min",
      value: minutes === null ? "–" : `${minutes} min`,
      met: minutes === null ? null : minutes <= 3,
    },
    {
      id: "log",
      label: "Actions missing from the run log",
      target: "0",
      value: `${missing}`,
      met: none ? null : missing === 0,
    },
    {
      id: "cost",
      label: "Claude cost per application",
      target: "≤ $0.03",
      value: meanCost === null ? "–" : `$${meanCost.toFixed(4)}`,
      met: meanCost === null ? null : meanCost <= 0.03,
    },
  ];
  return {
    applications,
    manualApplications: input.manualApplications,
    targets,
  };
}
