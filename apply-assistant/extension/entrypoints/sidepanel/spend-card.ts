import type { ApplyClient, ClaudeSummary, DeepSeekSpend } from "../../src/lib/api";
import { isLowCredit } from "./claude-spend-line";

/**
 * "AI spend" above the queue: Claude (Apply Copilot's runs) and DeepSeek (Job Ops' scoring),
 * one line folded, the breakdown when opened. A native <details>, so tap and keyboard work.
 */

/** Under this DeepSeek balance the line turns amber. */
export const DEEPSEEK_LOW_USD = 1;

const usd = (value: number): string => `$${Math.max(0, value).toFixed(2)}`;

export function claudeText(claude: ClaudeSummary | null): string {
  if (!claude) return "Claude unavailable";
  if (!claude.credit) return `Claude ${usd(claude.totalUsd)} spent`;
  return `Claude ${usd(claude.credit.spentSinceUsd)} spent · ≈${usd(claude.credit.remainingUsd)} left`;
}

export function deepseekText(deepseek: DeepSeekSpend | null): string {
  if (!deepseek) return "DeepSeek unavailable";
  const left = deepseek.balance ? `${usd(deepseek.balance.total)} left` : null;
  // Nothing tracked yet: "$0.00 spent" would read as all-time, so show only the balance.
  if (deepseek.calls === 0) return `DeepSeek ${left ?? "no calls tracked yet"}`;
  return `DeepSeek ${usd(deepseek.trackedUsd)} spent${left ? ` · ${left}` : ""}`;
}

export function isLowDeepSeek(deepseek: DeepSeekSpend | null): boolean {
  return !!deepseek?.balance && deepseek.balance.total < DEEPSEEK_LOW_USD;
}

const isNumber = (value: unknown): value is number => typeof value === "number";

/** Only a summary with the expected shape is shown: anything else reads as unavailable. */
export function asClaudeSummary(value: unknown): ClaudeSummary | null {
  const v = value as Partial<ClaudeSummary> | null;
  return v && isNumber(v.totalUsd) && isNumber(v.monthUsd) && isNumber(v.todayUsd) && Array.isArray(v.byModel)
    ? (v as ClaudeSummary)
    : null;
}

export function asDeepSeekSpend(value: unknown): DeepSeekSpend | null {
  const v = value as Partial<DeepSeekSpend> | null;
  return v && isNumber(v.trackedUsd) && isNumber(v.calls) && isNumber(v.todayUsd) && isNumber(v.monthUsd) && Array.isArray(v.byFeature)
    ? (v as DeepSeekSpend)
    : null;
}

/** "Nov 6" from an ISO time, in UTC like the server's day boundaries. */
function day(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

interface Row {
  readonly label: string;
  readonly value: string;
}

export function claudeRows(claude: ClaudeSummary): Row[] {
  return [
    { label: "Today", value: usd(claude.todayUsd) },
    { label: "This month", value: usd(claude.monthUsd) },
    { label: "All time", value: usd(claude.totalUsd) },
    ...claude.byModel.map((m) => ({
      label: m.model.replace(/^claude-/, ""),
      value: `${usd(m.usd)} · ${m.calls} calls`,
    })),
  ];
}

export function deepseekRows(deepseek: DeepSeekSpend): Row[] {
  return [
    { label: "Today", value: usd(deepseek.todayUsd) },
    { label: "This month", value: usd(deepseek.monthUsd) },
    ...deepseek.byFeature.map((f) => ({
      label: f.feature ?? "other",
      value: `${usd(f.usd)} · ${f.calls} calls`,
    })),
  ];
}

export function claudeNote(claude: ClaudeSummary): string {
  return claude.credit
    ? `"Left" is an estimate: ${usd(claude.credit.amountUsd)} loaded on ${claude.credit.asOf}, minus spend since then.`
    : "Anthropic doesn't share your balance: enter the credit you loaded to see what's left.";
}

export function deepseekNote(deepseek: DeepSeekSpend): string {
  if (deepseek.balanceError) return `Balance unavailable (${deepseek.balanceError}).`;
  const since = day(deepseek.since);
  return since
    ? `"Left" is DeepSeek's own balance. Spend is counted since ${since}.`
    : `"Left" is DeepSeek's own balance. Spend is counted from the next scoring run on.`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function section(title: string, rows: Row[], note: string): HTMLElement {
  const box = el("div", "spend-section");
  box.append(el("strong", "", title));
  const list = el("dl", "spend-rows");
  for (const row of rows) list.append(el("dt", "", row.label), el("dd", "", row.value));
  box.append(list, el("p", "muted", note));
  return box;
}

export interface SpendCard {
  readonly element: HTMLDetailsElement;
  refresh(): Promise<void>;
}

/** `onSetCredit` opens Settings, where the Claude credit is entered. */
export function createSpendCard(
  client: () => ApplyClient | null,
  onSetCredit: () => void,
): SpendCard {
  const element = el("details", "card spend");
  element.hidden = true;
  const summary = el("summary", "");
  const title = el("strong", "", "AI spend");
  const claudeLine = el("span", "");
  const deepseekLine = el("span", "");
  const lines = el("span", "spend-line");
  lines.append(claudeLine, deepseekLine);
  summary.append(title, lines);
  const body = el("div", "spend-body");
  element.append(summary, body);

  const setCredit = el("button", "link", "Set your Claude credit");
  setCredit.type = "button";
  setCredit.addEventListener("click", onSetCredit);

  let loading = false;
  return {
    element,
    async refresh() {
      const api = client();
      if (!api || loading) return;
      loading = true;
      try {
        // Each side is a nicety: one failing still shows the other.
        const [claude, deepseek] = await Promise.all([
          api.claudeSummary().then(asClaudeSummary, () => null),
          api.deepseekSpend().then(asDeepSeekSpend, () => null),
        ]);
        if (!claude && !deepseek) {
          element.hidden = true;
          return;
        }
        const claudeLow = !!claude && isLowCredit(claude);
        const deepseekLow = isLowDeepSeek(deepseek);
        claudeLine.textContent = claudeText(claude);
        claudeLine.className = claudeLow ? "low" : "";
        deepseekLine.textContent = deepseekText(deepseek);
        deepseekLine.className = deepseekLow ? "low" : "";
        summary.title = claudeLow || deepseekLow ? "Running low on credit" : "";
        body.replaceChildren(
          ...(claude
            ? [section("Claude · Apply Copilot runs", claudeRows(claude), claudeNote(claude))]
            : []),
          ...(claude && !claude.credit ? [setCredit] : []),
          ...(deepseek
            ? [section("DeepSeek · Job Ops scoring", deepseekRows(deepseek), deepseekNote(deepseek))]
            : []),
        );
        element.hidden = false;
      } finally {
        loading = false;
      }
    },
  };
}
