// Apply Assistant page: answer bank editor, queue with fill plans, and the run timeline.
// Talks only to this server's API with your Job Ops session token. Every value is rendered with
// textContent, never as HTML.

import { createProgress } from "./progress.js";
import { createTimeline } from "./timeline.js";

const TOKEN_KEY = "apply-assistant.token";

const storage = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: the session simply isn't remembered */
    }
  },
};

let token = storage.get();
let bankDraft = new Map();

const $ = (id) => document.getElementById(id);
const go = (hash) => {
  location.hash = hash;
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return node;
}

let toastTimer;
function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 4000);
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await res.json().catch(() => null);
  if (res.status === 401 && path !== "/auth/login") {
    signOut("Your session expired. Sign in again.");
    throw new ApiError(401, "UNAUTHORIZED", "Signed out");
  }
  if (!res.ok || !payload?.ok)
    throw new ApiError(
      res.status,
      payload?.error?.code ?? "ERROR",
      payload?.error?.message ?? `Request failed (${res.status})`,
    );
  return payload.data;
}

/** Authenticated fetch for non-JSON responses (snapshots, the export bundle). */
async function raw(path) {
  const res = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    signOut("Your session expired. Sign in again.");
    throw new ApiError(401, "UNAUTHORIZED", "Signed out");
  }
  return res;
}

// ---- views & routing -------------------------------------------------------------------

const VIEWS = ["login", "queue", "bank", "timeline", "progress"];
const timeline = createTimeline({ api, raw, el, go });
const progress = createProgress({ api, el, toast });

function show(view) {
  for (const name of VIEWS) $(name).hidden = name !== view;
  $("tabs").hidden = view === "login";
  for (const tab of document.querySelectorAll(".tab"))
    tab.toggleAttribute("aria-current", tab.dataset.tab === view);
  if (view !== "login")
    document
      .querySelector(`.tab[data-tab="${view}"]`)
      ?.setAttribute("aria-current", "page");
}

async function route() {
  if (!token) return show("login");
  const [view, arg] = location.hash
    .replace(/^#/, "")
    .split("/")
    .map(decodeURIComponent);
  try {
    if (view === "progress") {
      show("progress");
      await progress.loadProgress($("progress-box"));
    } else if (view === "timeline") {
      show("timeline");
      if (arg) await timeline.loadJob($("timeline-box"), arg);
      else await timeline.loadList($("timeline-box"));
    } else if (view === "bank") {
      show("bank");
      await Promise.all([loadBank(), progress.loadLearned($("learned"))]);
      if (arg) focusBankKey(arg);
    } else if (view === "plan" && arg) {
      show("queue");
      await Promise.all([loadQueue(), loadPlan(arg)]);
    } else {
      show("queue");
      $("plan").hidden = true;
      await loadQueue();
    }
  } catch (error) {
    if (error.status !== 401) toast(error.message);
  }
}

function signOut(message) {
  token = null;
  storage.set(null);
  bankDraft = new Map();
  show("login");
  if (message) toast(message);
}

// ---- login -----------------------------------------------------------------------------

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  // currentTarget is cleared once the handler awaits, so keep the form element.
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const error = $("login-error");
  error.hidden = true;
  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: { username: form.get("username"), password: form.get("password") },
    });
    token = data.token;
    storage.set(token);
    formElement.reset();
    await route();
  } catch (e) {
    error.textContent =
      e.status === 401 ? "Wrong username or password." : e.message;
    error.hidden = false;
  }
});

$("signout").addEventListener("click", () => signOut());
for (const tab of document.querySelectorAll(".tab"))
  tab.addEventListener("click", () => {
    location.hash = tab.dataset.tab;
  });

// ---- queue & plans ---------------------------------------------------------------------

const ATS_NAMES = { greenhouse: "Greenhouse", ashby: "Ashby", lever: "Lever" };

/** Badge for a job's posting: "On Ashby", "Not found", … */
function targetBadge(target) {
  const system = ATS_NAMES[target.ats] ?? "a supported system";
  const badges = {
    matched: ["ok", `On ${system}`],
    possible: ["warn", `Possible match on ${system}`],
    none: ["", "Not found"],
    closed: ["bad", "Posting closed"],
    pending: ["", "Not checked yet"],
  };
  return badges[target.status] ?? ["", target.status];
}

function planCell(plan) {
  if (!plan) return el("span", { class: "muted" }, "—");
  const { needsYou, fill, estMinutes } = plan.summary;
  return el(
    "span",
    {},
    el(
      "span",
      { class: `badge ${needsYou ? "warn" : "ok"}` },
      needsYou ? `${needsYou} need you` : "ready",
    ),
    " ",
    el(
      "span",
      { class: "muted num" },
      `${fill} auto-filled · ~${estMinutes} min`,
    ),
  );
}

async function loadQueue() {
  const jobs = await api("/queue");
  const box = $("queue-list");
  box.replaceChildren();
  if (jobs.length === 0) {
    box.append(
      el(
        "p",
        { class: "empty" },
        "No Ready jobs in Job Ops. Tailor a resume for a job to see it here.",
      ),
    );
    return;
  }
  const rows = jobs.map((job) => {
    const [tone, label] = targetBadge(job.target);
    const openPlan = () => go(`plan/${encodeURIComponent(job.jobId)}`);
    return el(
      "tr",
      {
        class: job.plan ? "clickable" : "",
        tabindex: job.plan ? "0" : undefined,
        onclick: job.plan ? openPlan : undefined,
        onkeydown: job.plan
          ? (e) => {
              if (e.key === "Enter") openPlan();
            }
          : undefined,
      },
      el(
        "td",
        {},
        el("div", {}, job.title),
        el("div", { class: "muted" }, job.employer),
      ),
      el("td", { class: "num hide-sm" }, job.score ?? "—"),
      el(
        "td",
        {},
        el("span", { class: `badge ${tone}` }, label),
        job.target.postingUrl
          ? el(
              "div",
              {},
              el(
                "a",
                {
                  href: job.target.postingUrl,
                  target: "_blank",
                  rel: "noopener",
                },
                "posting ↗",
              ),
            )
          : null,
      ),
      el("td", {}, planCell(job.plan)),
    );
  });
  box.append(
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
          el("th", { class: "hide-sm" }, "Score"),
          el("th", {}, "Posting"),
          el("th", {}, "Plan"),
        ),
      ),
      el("tbody", {}, rows),
    ),
  );
}

const STATUS_BADGE = {
  fill: ["ok", "fills"],
  "needs-you": ["warn", "needs you"],
  skip: ["", "skipped"],
};
const CLASS_LABEL = {
  auto: "auto",
  confirm: "your click",
  protected: "protected",
};

function valueText(entry) {
  if (entry.value === null || entry.value === undefined) return "";
  return Array.isArray(entry.value) ? entry.value.join(", ") : entry.value;
}

async function loadPlan(jobId) {
  const box = $("plan");
  box.hidden = false;
  box.replaceChildren(el("p", { class: "muted" }, "Building plan…"));
  let plan;
  try {
    plan = await api(`/plans/${encodeURIComponent(jobId)}`);
  } catch (error) {
    box.replaceChildren(el("p", { class: "error" }, error.message));
    return;
  }
  const visible = plan.entries.filter((e) => e.status !== "skip");
  const skipped = plan.entries.length - visible.length;
  const s = plan.summary;
  box.replaceChildren(
    el(
      "div",
      { class: "section-head" },
      el(
        "div",
        {},
        el("h3", {}, "Fill plan"),
        el(
          "p",
          { class: "muted" },
          `${s.fill} will fill (${s.auto} auto, ${s.confirm} your click, ${s.protected} protected) · ${s.needsYou} need you · ~${s.estMinutes} min`,
          plan.jobCountry ? ` · job in ${plan.jobCountry}` : "",
        ),
      ),
      el("button", { type: "button", onclick: () => go("queue") }, "Close"),
    ),
    el(
      "table",
      { class: "rows" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "Field"),
          el("th", {}, "Status"),
          el("th", { class: "hide-sm" }, "Gate"),
          el("th", {}, "Value / why"),
        ),
      ),
      el(
        "tbody",
        {},
        visible.map((entry) => {
          const [tone, label] = STATUS_BADGE[entry.status];
          const why =
            entry.status === "needs-you"
              ? el(
                  "span",
                  {},
                  el("span", { class: "muted" }, entry.reason ?? ""),
                  entry.bankKey
                    ? [
                        " ",
                        el(
                          "a",
                          {
                            href: `#bank/${encodeURIComponent(entry.bankKey)}`,
                          },
                          "Answer it →",
                        ),
                      ]
                    : null,
                )
              : el(
                  "span",
                  {},
                  el("span", { class: "value" }, valueText(entry)),
                  el("div", { class: "muted" }, entry.source),
                );
          return el(
            "tr",
            {},
            el(
              "td",
              {},
              entry.label,
              entry.required ? el("span", { class: "muted" }, " *") : null,
            ),
            el("td", {}, el("span", { class: `badge ${tone}` }, label)),
            el(
              "td",
              { class: "hide-sm" },
              el(
                "span",
                {
                  class: `badge ${entry.actionClass === "protected" ? "protected" : ""}`,
                },
                CLASS_LABEL[entry.actionClass],
              ),
            ),
            el("td", {}, why),
          );
        }),
      ),
    ),
    skipped
      ? el(
          "p",
          { class: "muted" },
          `${skipped} optional or page-filled fields left empty.`,
        )
      : null,
  );
}

$("refresh-queue").addEventListener("click", () => route());

// ---- answer bank -----------------------------------------------------------------------

function inputFor(def, current) {
  const common = {
    id: `bank-${def.key}`,
    name: def.key,
    "data-key": def.key,
    placeholder: def.example ? `e.g. ${def.example}` : undefined,
    "aria-describedby": `help-${def.key}`,
    oninput: (e) => onBankInput(def.key, e.currentTarget.value, current),
  };
  if (def.kind === "yesno")
    return el(
      "select",
      common,
      ["", "Yes", "No"].map((v) =>
        el("option", { value: v, selected: v === current }, v || "—"),
      ),
    );
  if (def.kind === "list")
    return el("textarea", { ...common, rows: "2" }, current);
  if (def.multiline) return el("textarea", { ...common, rows: "4" }, current);
  if (def.kind === "date")
    return el("input", { ...common, type: "date", value: current });
  if (def.kind === "days")
    return el("input", {
      ...common,
      type: "number",
      min: "0",
      max: "365",
      step: "1",
      inputmode: "numeric",
      value: current,
    });
  if (def.kind === "number")
    return el("input", {
      ...common,
      type: "number",
      min: "0",
      step: "0.5",
      inputmode: "decimal",
      value: current,
    });
  return el("input", { ...common, value: current });
}

function onBankInput(key, value, original) {
  if (value === original) bankDraft.delete(key);
  else bankDraft.set(key, value);
  document
    .querySelector(`[data-field="${CSS.escape(key)}"]`)
    ?.classList.toggle("changed", bankDraft.has(key));
  $("save-bank").disabled = bankDraft.size === 0;
}

async function loadBank() {
  const { keys, custom } = await api("/answer-bank");
  bankDraft = new Map();
  $("save-bank").disabled = true;
  const groups = new Map();
  for (const def of keys)
    groups.set(def.group, [...(groups.get(def.group) ?? []), def]);
  const form = $("bank-form");
  const sections = [
    ...[...groups.entries()].map(([group, defs]) =>
      el(
        "fieldset",
        { class: "card bank-group" },
        el("h3", {}, group),
        defs.map((def) =>
          el(
            "div",
            { class: "bank-field", "data-field": def.key },
            el(
              "label",
              { for: `bank-${def.key}`, class: "field-label" },
              def.label,
              def.protected
                ? el("span", { class: "badge protected" }, "protected")
                : null,
              def.value ? null : el("span", { class: "badge" }, "empty"),
            ),
            inputFor(def, def.value ?? ""),
            el(
              "div",
              { class: "hint", id: `help-${def.key}` },
              def.example ? `Example: ${def.example}` : "",
              def.example && def.hint ? " · " : "",
              def.hint ?? "",
            ),
            el("div", { class: "field-error", role: "alert", hidden: true }),
          ),
        ),
      ),
    ),
    custom.length
      ? el(
          "fieldset",
          { class: "card bank-group" },
          el("h3", {}, "Learned answers"),
          custom.map((a) =>
            el(
              "div",
              { class: "bank-field", "data-field": a.key },
              el(
                "label",
                { for: `bank-${a.key}`, class: "field-label" },
                a.key,
              ),
              inputFor({ key: a.key, kind: "text" }, a.value),
            ),
          ),
        )
      : null,
  ];
  // replaceChildren would print a null as text, so drop the absent "Learned answers" block.
  form.replaceChildren(...sections.filter(Boolean));
}

function focusBankKey(key) {
  const field = document.querySelector(`[data-field="${CSS.escape(key)}"]`);
  if (!field) return;
  field.scrollIntoView({ block: "center" });
  field.classList.remove("flash");
  void field.offsetWidth;
  field.classList.add("flash");
  field.querySelector("input, textarea, select")?.focus();
}

function showFieldError(key, message) {
  const box = document.querySelector(
    `[data-field="${CSS.escape(key)}"] .field-error`,
  );
  if (!box) return;
  box.textContent = message ?? "";
  box.hidden = !message;
}

$("save-bank").addEventListener("click", async () => {
  const button = $("save-bank");
  button.disabled = true;
  const entries = [...bankDraft.entries()];
  const failed = [];
  try {
    for (const [key, value] of entries) {
      try {
        await api(`/answer-bank/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: { value: value.trim() },
        });
      } catch (error) {
        if (error.status === 401) throw error;
        failed.push({ key, value, message: error.message });
      }
    }
    const saved = entries.length - failed.length;
    const rebuilt = saved
      ? await api("/plans/rebuild", { method: "POST", body: {} })
      : { rebuilt: 0 };
    await loadBank();
    // Keep what didn't save in the form, with the reason under the field.
    for (const { key, value, message } of failed) {
      const input = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (input) input.value = value;
      onBankInput(key, value, null);
      showFieldError(key, message.replace(/^[^:]+: /, ""));
    }
    toast(
      failed.length
        ? `Saved ${saved} · ${failed.length} need fixing (see the red notes)`
        : `Saved ${saved} answer${saved === 1 ? "" : "s"} · ${rebuilt.rebuilt} plan${rebuilt.rebuilt === 1 ? "" : "s"} updated`,
    );
  } catch (error) {
    if (error.status !== 401) toast(`Not saved: ${error.message}`);
    button.disabled = bankDraft.size === 0;
  }
});

$("bank-form").addEventListener("submit", (e) => e.preventDefault());
window.addEventListener("hashchange", route);
route();
