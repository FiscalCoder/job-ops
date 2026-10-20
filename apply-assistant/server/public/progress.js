// Progress (M4): the plan's targets measured from your submitted supervised applications, and
// the answers remembered from your edits. Every value is rendered with textContent.

const STATUS = {
  true: ["badge ok", "met"],
  false: ["badge bad", "not yet"],
  null: ["badge", "no data yet"],
};

const date = (iso) => {
  const d = new Date(`${String(iso).replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
};

/**
 * @param {object} deps
 * @param {(path: string, options?: object) => Promise<any>} deps.api JSON API call
 * @param {Function} deps.el element builder
 * @param {(message: string) => void} deps.toast
 */
export function createProgress({ api, el, toast }) {
  async function loadProgress(box) {
    box.replaceChildren(el("p", { class: "muted" }, "Loading…"));
    const data = await api("/progress");
    const targets = el(
      "table",
      { class: "rows" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "Target"),
          el("th", {}, "Goal"),
          el("th", {}, "Now"),
          el("th", {}, ""),
        ),
      ),
      el(
        "tbody",
        {},
        data.targets.map((t) => {
          const [tone, text] = STATUS[String(t.met)];
          return el(
            "tr",
            {},
            el("td", {}, t.label),
            el("td", { class: "num" }, t.target),
            el("td", { class: "num" }, t.value),
            el("td", {}, el("span", { class: tone }, text)),
          );
        }),
      ),
    );
    const apps = data.applications.length
      ? el(
          "table",
          { class: "rows" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, "Application"),
              el("th", {}, "Submitted"),
              el("th", { class: "num" }, "Steps"),
              el("th", { class: "num" }, "By you"),
              el("th", { class: "num" }, "Minutes"),
              el("th", { class: "num" }, "Claude"),
            ),
          ),
          el(
            "tbody",
            {},
            [...data.applications]
              .reverse()
              .map((a) =>
                el(
                  "tr",
                  {},
                  el(
                    "td",
                    {},
                    el("div", {}, a.title ?? a.jobId),
                    el("div", { class: "muted" }, a.employer ?? ""),
                  ),
                  el("td", {}, date(a.submittedAt)),
                  el("td", { class: "num" }, String(a.steps)),
                  el(
                    "td",
                    { class: "num" },
                    String(a.byYou),
                    a.protectedChanged
                      ? el(
                          "span",
                          { class: "badge bad" },
                          `${a.protectedChanged} protected`,
                        )
                      : null,
                  ),
                  el(
                    "td",
                    { class: "num" },
                    a.minutes === null ? "–" : String(a.minutes),
                  ),
                  el(
                    "td",
                    { class: "num" },
                    a.cost === null ? "–" : `$${a.cost.toFixed(4)}`,
                  ),
                ),
              ),
          ),
        )
      : el(
          "p",
          { class: "empty" },
          "No supervised application submitted yet. Start one from the side panel.",
        );
    box.replaceChildren(
      targets,
      el(
        "p",
        { class: "muted" },
        `"By you" counts steps you changed, typed yourself or skipped; editing a step back to the same value counts as approving it. Applications made by hand with the kit (${data.manualApplications}) aren't counted toward these targets.`,
      ),
      el("h3", {}, "Supervised applications"),
      apps,
    );
  }

  /** The answers remembered from your edits, deletable when one is wrong. */
  async function loadLearned(box) {
    const answers = await api("/learned");
    const rows = answers.map((a) => {
      const remove = el(
        "button",
        {
          type: "button",
          class: "link",
          onclick: async () => {
            remove.disabled = true;
            try {
              await api(`/learned/${a.id}`, { method: "DELETE" });
              toast("Forgot that answer; plans are being refreshed.");
              await loadLearned(box);
            } catch (error) {
              remove.disabled = false;
              toast(error.message);
            }
          },
        },
        "Forget",
      );
      return el(
        "tr",
        {},
        el("td", {}, a.label),
        el(
          "td",
          { class: "value" },
          Array.isArray(a.value) ? a.value.join(", ") : a.value,
        ),
        el(
          "td",
          {},
          a.how === "typed" ? "typed on the page" : "edited",
          el("div", { class: "muted" }, date(a.updatedAt)),
        ),
        el("td", {}, remove),
      );
    });
    box.replaceChildren(
      el("h3", {}, "Remembered answers"),
      el(
        "p",
        { class: "muted" },
        "When you change an answer during a fill, or type it on the page yourself, it's reused the next time a form asks the same question (the company's name doesn't matter). Forget one to stop reusing it.",
      ),
      rows.length
        ? el(
            "table",
            { class: "rows" },
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                el("th", {}, "Question"),
                el("th", {}, "Your answer"),
                el("th", {}, "How"),
                el("th", {}, ""),
              ),
            ),
            el("tbody", {}, rows),
          )
        : el("p", { class: "empty" }, "Nothing remembered yet."),
    );
  }

  return { loadProgress, loadLearned };
}
