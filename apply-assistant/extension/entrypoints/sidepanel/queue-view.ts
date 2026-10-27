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
const groupKey = (item: QueueItem) =>
  item.companyLimit?.name.toLowerCase() ??
  item.employer.replace(LEGAL, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Companies with their roles, best-scored company first; roles best-scored first. */
export function groupByCompany(items: readonly QueueItem[]): CompanyGroup[] {
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = groupKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const best = (list: readonly QueueItem[]) =>
    Math.max(...list.map((i) => i.score ?? 0));
  return [...groups.values()]
    .map((list) => {
      const roles = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const first = roles[0] as QueueItem;
      return {
        company: first.companyLimit?.name ?? first.employer,
        items: roles,
        limit: first.companyLimit ?? null,
      };
    })
    .sort((a, b) => best(b.items) - best(a.items));
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
  /** One role's row (its badges, kit button, click to see the plan). */
  readonly row: (item: QueueItem, showEmployer: boolean) => HTMLElement;
  /** Marks the company as one application per six months. */
  readonly limit: (company: string) => void;
  readonly unlimit: (limit: CompanyWindow) => void;
  /** Never apply there: blocked in Job Ops, its jobs skipped. */
  readonly block: (company: string) => void;
}

export function renderQueue(
  list: HTMLElement,
  items: readonly QueueItem[],
  actions: QueueViewActions,
): void {
  if (items.length === 0) {
    list.replaceChildren(
      el("li", { class: "muted" }, "No Ready jobs in Job Ops."),
    );
    return;
  }
  list.replaceChildren(
    ...groupByCompany(items).flatMap((group) => {
      const button = (label: string, onClick: () => void) => {
        const b = el("button", { type: "button", class: "link" }, label);
        b.addEventListener("click", (event) => {
          event.stopPropagation();
          onClick();
        });
        return b;
      };
      const limit = group.limit ? limitText(group.limit) : null;
      const header = el(
        "li",
        { class: "company" },
        el(
          "div",
          { class: "row" },
          el(
            "strong",
            {},
            group.company,
            group.items.length > 1 ? ` · ${group.items.length} roles` : "",
          ),
          el(
            "span",
            {},
            group.limit
              ? button("Remove limit", () =>
                  actions.unlimit(group.limit as CompanyWindow),
                )
              : button("Limit…", () => actions.limit(group.company)),
            " ",
            button("Block…", () => actions.block(group.company)),
          ),
        ),
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
