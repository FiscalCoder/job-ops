import type { CompanyWindow, QueueItem } from "../../src/lib/api";

/**
 * The queue, grouped by company: each role with when it was posted, and for a company that
 * takes only so many applications from you (Amazon: one per six months) where you stand, so
 * you pick your one best role there.
 */

function el(
  tag: string,
  attrs: Record<string, string | undefined> = {},
  ...children: (Node | string | null)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs))
    if (value !== undefined) node.setAttribute(key, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

export interface CompanyGroup {
  readonly company: string;
  readonly items: readonly QueueItem[];
  readonly limit: CompanyWindow | null;
}

const LEGAL =
  /\b(private|pvt|limited|ltd|llp|llc|inc|corp|corporation|gmbh|plc|india)\b\.?/gi;
/** One key per company ("Acme Pvt Ltd" = "acme"): its group, and what Hide hides. */
export const companyKey = (item: QueueItem): string =>
  item.companyLimit?.name.toLowerCase() ??
  item.employer.replace(LEGAL, "").replace(/\s+/g, " ").trim().toLowerCase();
const groupKey = companyKey;

/** How the queue is ordered: grouped by company (best match, A-Z) or one list by date. */
export type QueueSort = "best" | "posted" | "found" | "company";
export const QUEUE_SORTS: readonly { value: QueueSort; label: string }[] = [
  { value: "best", label: "Best match" },
  { value: "posted", label: "Newest posted" },
  { value: "found", label: "Recently found" },
  { value: "company", label: "Company A–Z" },
];
const flat = (sort: QueueSort): sort is "posted" | "found" =>
  sort === "posted" || sort === "found";

/** A closed posting can't be applied to: it goes last in every order. */
const isOpen = (item: QueueItem) => item.target.status !== "closed";
const time = (iso: string | null | undefined) => {
  const t = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isNaN(t) ? null : t;
};

/** One list, newest posted (or found) first; undated ones, then closed ones, last. */
export function sortedFlat(
  items: readonly QueueItem[],
  sort: "posted" | "found",
): QueueItem[] {
  const when = (i: QueueItem) =>
    time(sort === "posted" ? i.postedAt : i.foundAt);
  return [...items].sort((a, b) => {
    if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
    const ta = when(a);
    const tb = when(b);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    return (b.score ?? 0) - (a.score ?? 0);
  });
}

/** Where a job's link goes ("careers.acme.com"), for search. */
const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

/**
 * The queue's search: every word you type is in the job's company, role, system (Greenhouse,
 * Workday…) or site, in any order and case ("acme backend", "greenhouse senior").
 */
export function matchesSearch(item: QueueItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [
    item.title,
    item.employer,
    item.target.ats ?? "",
    hostOf(item.applicationLink),
    hostOf(item.jobUrl),
    hostOf(item.target.postingUrl),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * Companies with their roles: best-scored company first (or A-Z); roles best-scored first.
 * Closed roles go last, and a company with nothing open last of all.
 */
export function groupByCompany(
  items: readonly QueueItem[],
  sort: QueueSort = "best",
): CompanyGroup[] {
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = groupKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const best = (list: readonly QueueItem[]) =>
    Math.max(-1, ...list.filter(isOpen).map((i) => i.score ?? 0));
  const byScore = (a: QueueItem, b: QueueItem) =>
    isOpen(a) !== isOpen(b)
      ? isOpen(a)
        ? -1
        : 1
      : (b.score ?? 0) - (a.score ?? 0);
  return [...groups.values()]
    .map((list) => {
      const roles = [...list].sort(byScore);
      const first = roles[0] as QueueItem;
      return {
        company: first.companyLimit?.name ?? first.employer,
        items: roles,
        limit: first.companyLimit ?? null,
      };
    })
    .sort((a, b) =>
      sort === "company"
        ? a.company.localeCompare(b.company, undefined, { sensitivity: "base" })
        : best(b.items) - best(a.items),
    );
}

/** The queue's filters (none set: every job). */
export interface QueueFilters {
  /** Posted within this many days ("any": no limit). */
  readonly posted: "any" | "1" | "3" | "7";
  readonly remote: boolean;
  /** Only jobs whose form plan is ready (Greenhouse, Ashby, Lever): one click fills them. */
  readonly ready: boolean;
}
export const NO_FILTERS: QueueFilters = {
  posted: "any",
  remote: false,
  ready: false,
};

/** One click fills it: its posting is found and its form planned. */
export const isReadyToFill = (item: QueueItem): boolean =>
  item.plan !== null && item.target.status === "matched";

const DAY_MS = 86_400_000;

export function passesFilters(
  item: QueueItem,
  filters: QueueFilters,
  now = new Date(),
): boolean {
  if (filters.ready && !isReadyToFill(item)) return false;
  if (filters.remote && !/\bremote\b/i.test(`${item.location ?? ""} ${item.title}`))
    return false;
  if (filters.posted !== "any") {
    const posted = time(item.postedAt);
    // A plain date ("2026-10-21") counts from the end of its day; a time, from that time.
    const latest =
      posted === null
        ? null
        : /^\d{4}-\d{2}-\d{2}$/.test(item.postedAt ?? "")
          ? posted + DAY_MS
          : posted;
    if (latest === null || now.getTime() - latest > Number(filters.posted) * DAY_MS)
      return false;
  }
  return true;
}

/** Found since you last opened the panel (`since` null: the first time, nothing is new). */
export const isNew = (item: QueueItem, since: number | null): boolean => {
  const found = time(item.foundAt);
  return since !== null && found !== null && found > since;
};

const ATS_NAMES: Record<string, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
};
/** Application systems by their address, for "Apply on Workday". */
const SITES: readonly [RegExp, string][] = [
  [/myworkdayjobs\.com$|myworkdaysite\.com$/, "Workday"],
  [/oraclecloud\.com$/, "Oracle"],
  [/icims\.com$/, "iCIMS"],
  [/successfactors\.|sapsf\./, "SuccessFactors"],
  [/zohorecruit\./, "Zoho Recruit"],
  [/keka\.com$/, "Keka"],
  [/eightfold\.ai$/, "Eightfold"],
  [/greenhouse\.io$/, "Greenhouse"],
  [/ashbyhq\.com$/, "Ashby"],
  [/lever\.co$/, "Lever"],
  [/linkedin\.com$/, "LinkedIn"],
  [/naukri\.com$/, "Naukri"],
];

/**
 * Where you apply, at a glance: the posting found on Greenhouse/Ashby/Lever, closed, still
 * being looked up, else the system or site its link goes to ("Apply on Workday"). Null when
 * there's no link to tell from.
 */
export function applyBadge(
  item: QueueItem,
): { readonly tone: string; readonly label: string } | null {
  const { target } = item;
  const system = ATS_NAMES[target.ats ?? ""] ?? "a supported system";
  switch (target.status) {
    case "matched":
      return { tone: "ok", label: `On ${system}` };
    case "possible":
      return { tone: "warn", label: `Possible match on ${system}` };
    case "closed":
      return { tone: "bad", label: "Closed" };
    case "pending":
      return { tone: "", label: "Finding where to apply" };
  }
  const host = hostOf(item.applicationLink) || hostOf(item.jobUrl);
  if (!host) return null;
  const site = SITES.find(([pattern]) => pattern.test(host))?.[1];
  return { tone: "", label: `Apply on ${site ?? "company site"}` };
}

/** "6 months", "30 days". */
export function periodText(days: number): string {
  if (days >= 60) {
    const months = Math.round(days / 30.4);
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** "posted today", "posted 3 days ago", "posted 12 Sep". */
export function postedText(
  postedAt: string | null | undefined,
  now = new Date(),
): string {
  if (!postedAt) return "";
  const at = new Date(postedAt);
  if (Number.isNaN(at.getTime())) return "";
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days <= 0) return "posted today";
  if (days === 1) return "posted yesterday";
  if (days < 30) return `posted ${days} days ago`;
  return `posted ${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** The limit in words, and whether you can still apply. */
export function limitText(limit: CompanyWindow): {
  text: string;
  tone: string;
} {
  const rule = `${limit.maxApplications} per ${periodText(limit.windowDays)}`;
  if (limit.full) {
    const last = limit.used[0];
    return {
      text: `${rule}: used${last ? ` (${last.title}, ${day(last.appliedAt)})` : ""}. Next opens ${limit.nextOpen ? day(limit.nextOpen) : "later"}`,
      tone: "bad",
    };
  }
  const left = limit.maxApplications - limit.used.length;
  return {
    text:
      limit.maxApplications === 1
        ? `${rule}: pick your one best role`
        : `${rule}: ${left} left`,
    tone: "warn",
  };
}

export interface QueueViewActions {
  /**
   * One role's row (its badges, kit button, click to see the plan). `menu`: its company's
   * menu, in a list sorted by date (no company header above it).
   */
  readonly row: (
    item: QueueItem,
    showEmployer: boolean,
    menu?: HTMLElement,
  ) => HTMLElement;
  /** Marks the company as one application per six months. */
  readonly limit: (company: string) => void;
  readonly unlimit: (limit: CompanyWindow) => void;
  /** Never apply there: blocked in Job Ops, its jobs skipped. */
  readonly block: (company: string) => void;
  /** Out of your queue (and Autopilot's) for now, on this browser; nothing changes in Job Ops. */
  readonly hide: (key: string, company: string) => void;
  readonly unhide: (key: string) => void;
}

export interface QueueViewOptions {
  readonly sort?: QueueSort;
  /** Hidden companies (by companyKey): listed only when you ask, each with Unhide. */
  readonly hidden?: ReadonlySet<string>;
}

/** A company's "⋯" menu: Hide (or Unhide), Limit… (or Remove limit), Block…. */
function companyMenu(
  company: string,
  key: string,
  limit: CompanyWindow | null,
  hidden: boolean,
  actions: QueueViewActions,
): HTMLElement {
  const menu = el("details", { class: "menu" }) as HTMLDetailsElement;
  const item = (label: string, onClick: () => void) => {
    const b = el("button", { type: "button", role: "menuitem" }, label);
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.open = false;
      onClick();
    });
    return b;
  };
  const summary = el(
    "summary",
    {
      "aria-label": `More for ${company}`,
      title: `Hide, limit or block ${company}`,
    },
    "⋯",
  );
  // Opening the menu never opens the row's plan.
  summary.addEventListener("click", (event) => event.stopPropagation());
  menu.append(
    summary,
    el(
      "div",
      { class: "menu-list", role: "menu" },
      hidden
        ? item("Unhide", () => actions.unhide(key))
        : item("Hide company", () => actions.hide(key, company)),
      limit
        ? item("Remove limit", () => actions.unlimit(limit))
        : item("Limit…", () => actions.limit(company)),
      item("Block…", () => actions.block(company)),
    ),
  );
  return menu;
}

export function renderQueue(
  list: HTMLElement,
  items: readonly QueueItem[],
  actions: QueueViewActions,
  options: QueueViewOptions = {},
): void {
  const sort = options.sort ?? "best";
  const hidden = options.hidden ?? new Set<string>();
  if (items.length === 0) {
    list.replaceChildren(
      el("li", { class: "muted" }, "No Ready jobs in Job Ops."),
    );
    return;
  }
  if (flat(sort)) {
    list.replaceChildren(
      ...sortedFlat(items, sort).map((item) => {
        const key = companyKey(item);
        const row = actions.row(
          item,
          true,
          companyMenu(
            item.employer,
            key,
            item.companyLimit ?? null,
            hidden.has(key),
            actions,
          ),
        );
        if (hidden.has(key)) row.classList.add("hidden-company");
        row.dataset.company = item.employer;
        return row;
      }),
    );
    return;
  }
  list.replaceChildren(
    ...groupByCompany(items, sort).flatMap((group) => {
      const key = companyKey(group.items[0] as QueueItem);
      const isHidden = hidden.has(key);
      const limit = group.limit ? limitText(group.limit) : null;
      const header = el(
        "li",
        {
          class: `company${isHidden ? " hidden-company" : ""}`,
          "data-company": group.company,
        },
        el(
          "div",
          { class: "row" },
          el(
            "strong",
            { class: "label" },
            group.company,
            group.items.length > 1 ? ` · ${group.items.length} roles` : "",
          ),
          companyMenu(group.company, key, group.limit, isHidden, actions),
        ),
        isHidden
          ? el("div", { class: "muted" }, "Hidden from your queue and Autopilot")
          : null,
        limit ? el("div", { class: `badge ${limit.tone}` }, limit.text) : null,
      );
      return [
        header,
        ...group.items.map((item) =>
          actions.row(item, item.employer.trim() !== group.company.trim()),
        ),
      ];
    }),
  );
}
