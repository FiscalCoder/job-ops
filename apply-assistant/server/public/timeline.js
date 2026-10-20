// Timeline: the run trace per job (what the server, the extension and the page did), with
// page snapshots. Snapshots open in a sandboxed frame: nothing in them can run.
// Every value is rendered with textContent, never as HTML.

const FAILURES = new Set(["step-failed", "stall", "error", "trace-problem"]);
// The page's own errors: often harmless (analytics, sign-in checks), sometimes the cause.
const PAGE_ISSUES = new Set(["console-error", "request-failed", "http-error"]);

const SOURCE_LABEL = { server: "server", extension: "extension", page: "page" };

const time = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};

/**
 * @param {object} deps
 * @param {(path: string) => Promise<any>} deps.api JSON API call (envelope unwrapped)
 * @param {(path: string) => Promise<Response>} deps.raw authenticated fetch
 * @param {Function} deps.el element builder
 * @param {(hash: string) => void} deps.go navigate
 */
export function createTimeline({ api, raw, el, go }) {
  async function loadList(box) {
    const jobs = await api("/trace/jobs");
    if (jobs.length === 0) {
      box.replaceChildren(
        el(
          "p",
          { class: "empty" },
          "Nothing recorded yet. Supervised fills and the apply kit record here.",
        ),
      );
      return;
    }
    const open = (jobId) => go(`timeline/${encodeURIComponent(jobId)}`);
    box.replaceChildren(
      el(
        "table",
        { class: "rows" },
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, "Job"),
            el("th", {}, "Last activity"),
            el("th", { class: "num" }, "Events"),
            el("th", {}, "Last event"),
          ),
        ),
        el(
          "tbody",
          {},
          jobs.map((job) =>
            el(
              "tr",
              {
                class: "clickable",
                tabindex: "0",
                onclick: () => open(job.jobId),
                onkeydown: (e) => {
                  if (e.key === "Enter") open(job.jobId);
                },
              },
              el(
                "td",
                {},
                el("div", {}, job.title ?? job.jobId),
                el(
                  "div",
                  { class: "muted" },
                  [job.employer, job.status].filter(Boolean).join(" · "),
                ),
              ),
              el("td", {}, time(job.lastTs)),
              el(
                "td",
                { class: "num" },
                String(job.events),
                job.failures
                  ? el(
                      "span",
                      { class: "badge bad" },
                      `${job.failures} problem${job.failures === 1 ? "" : "s"}`,
                    )
                  : null,
              ),
              el("td", { class: "value" }, job.lastMessage),
            ),
          ),
        ),
      ),
    );
  }

  /** Loads a snapshot below its event: the page in a sandboxed frame, or the screenshot. */
  async function viewSnapshot(holder, snapshot) {
    holder.replaceChildren(el("p", { class: "muted" }, "Loading…"));
    const res = await raw(
      `/trace/snapshots/${encodeURIComponent(snapshot.id)}`,
    );
    if (!res.ok) {
      holder.replaceChildren(
        el(
          "p",
          { class: "error" },
          "This snapshot is gone (older than 60 days?).",
        ),
      );
      return;
    }
    if (snapshot.kind === "dom") {
      const frame = el("iframe", {
        class: "snapshot",
        sandbox: "",
        title: `Page snapshot: ${snapshot.reason}`,
      });
      frame.srcdoc = await res.text();
      holder.replaceChildren(
        el("p", { class: "muted" }, snapshot.url ?? ""),
        frame,
      );
      return;
    }
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    holder.replaceChildren(
      el("img", {
        class: "snapshot",
        src: dataUrl,
        alt: `Screenshot: ${snapshot.reason}`,
      }),
    );
  }

  function eventRow(event, snapshots) {
    const failure = FAILURES.has(event.kind);
    const pageIssue = PAGE_ISSUES.has(event.kind);
    const snapshot = event.snapshotId ? snapshots.get(event.snapshotId) : null;
    const holder = el("div", { class: "snapshot-holder" });
    const details =
      event.data === null || event.data === undefined
        ? null
        : el(
            "details",
            {},
            el("summary", {}, "Details"),
            el("pre", {}, JSON.stringify(event.data, null, 2)),
          );
    return el(
      "li",
      {
        class: failure
          ? "event failure"
          : pageIssue
            ? "event page-issue"
            : "event",
      },
      el(
        "div",
        { class: "event-head" },
        el("span", { class: "muted" }, clock(event.ts)),
        el(
          "span",
          { class: "badge" },
          SOURCE_LABEL[event.source] ?? event.source,
        ),
        el(
          "span",
          { class: failure ? "badge bad" : pageIssue ? "badge warn" : "badge" },
          event.kind,
        ),
        event.stepSeq
          ? el("span", { class: "muted" }, `step ${event.stepSeq}`)
          : null,
      ),
      el("div", { class: "value" }, event.message),
      details,
      snapshot
        ? el(
            "button",
            {
              type: "button",
              onclick: (e) => {
                e.currentTarget.remove();
                void viewSnapshot(holder, snapshot);
              },
            },
            snapshot.kind === "dom" ? "View page" : "View screenshot",
          )
        : null,
      holder,
    );
  }

  async function exportTrail(jobId) {
    const res = await raw(`/trace/jobs/${encodeURIComponent(jobId)}/export`);
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const link = el("a", { href: url, download: `trace-${jobId}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function loadJob(box, jobId) {
    box.replaceChildren(el("p", { class: "muted" }, "Loading…"));
    const [trail, jobs] = await Promise.all([
      api(`/trace/jobs/${encodeURIComponent(jobId)}`),
      api("/trace/jobs"),
    ]);
    const job = jobs.find((j) => j.jobId === jobId);
    const snapshots = new Map(trail.snapshots.map((s) => [s.id, s]));
    const runs = new Map(trail.runs.map((r) => [r.id, r]));
    const onlyProblems = el("input", { type: "checkbox" });
    const list = el("ol", { class: "events" });

    const render = () => {
      const shown = trail.events.filter(
        (e) =>
          !onlyProblems.checked ||
          FAILURES.has(e.kind) ||
          PAGE_ISSUES.has(e.kind) ||
          e.kind === "snapshot",
      );
      const items = [];
      let currentRun;
      for (const event of shown) {
        if (event.runId !== currentRun) {
          currentRun = event.runId;
          const run = currentRun ? runs.get(currentRun) : null;
          items.push(
            el(
              "li",
              { class: "run-head" },
              run
                ? `Run started ${time(run.startedAt)} · ${run.outcome ?? "not finished"} · ${run.interventions} step(s) by you`
                : "Outside a run",
            ),
          );
        }
        items.push(eventRow(event, snapshots));
      }
      list.replaceChildren(
        ...(items.length
          ? items
          : [el("li", { class: "muted" }, "No events.")]),
      );
    };
    onlyProblems.addEventListener("change", render);

    const exportButton = el(
      "button",
      {
        type: "button",
        class: "primary",
        onclick: async () => {
          exportButton.disabled = true;
          try {
            await exportTrail(jobId);
          } finally {
            exportButton.disabled = false;
          }
        },
      },
      "Export trail (JSON)",
    );
    box.replaceChildren(
      el(
        "div",
        { class: "section-head" },
        el(
          "div",
          {},
          el("h3", {}, job?.title ?? jobId),
          el(
            "p",
            { class: "muted" },
            [job?.employer, job?.status, `${trail.events.length} events`]
              .filter(Boolean)
              .join(" · "),
          ),
        ),
        el(
          "div",
          { class: "actions" },
          el(
            "button",
            { type: "button", onclick: () => go("timeline") },
            "All jobs",
          ),
          exportButton,
        ),
      ),
      el(
        "label",
        { class: "inline" },
        onlyProblems,
        "Only problems and snapshots",
      ),
      list,
    );
    render();
  }

  return { loadList, loadJob };
}
