import { getAiSpend } from "@client/api";
import type {
  AiSpendResponse,
  ClaudeSpend,
  DeepSeekSpend,
} from "@client/api/ai-spend";
import { Tip } from "@client/components/Tip";
import { useQuery } from "@tanstack/react-query";
import type React from "react";
import { cn } from "@/lib/utils";

const REFRESH_MS = 5 * 60 * 1000;
/** Below these, the chip turns amber so a top-up isn't a surprise mid-run. */
export const CLAUDE_LOW_USD = 2;
export const DEEPSEEK_LOW_USD = 1;

const usd = (value: number): string => `$${value.toFixed(2)}`;

function formatSince(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function describeClaude(claude: ClaudeSpend | null): string {
  if (!claude) return "unavailable";
  if (!claude.credit) return `${usd(claude.totalUsd)} spent`;
  return `${usd(claude.credit.spentSinceUsd)} spent · ≈${usd(Math.max(0, claude.credit.remainingUsd))} left`;
}

export function describeDeepSeek(deepseek: DeepSeekSpend): string {
  // Nothing tracked yet: "$0.00 spent" would read as all-time, so show only the balance.
  if (deepseek.calls === 0) {
    return deepseek.balance
      ? `${usd(deepseek.balance.total)} left`
      : "no calls tracked yet";
  }
  const since = formatSince(deepseek.since);
  const spent = `${usd(deepseek.trackedUsd)} spent${since ? ` since ${since}` : ""}`;
  if (!deepseek.balance) return spent;
  return `${spent} · ${usd(deepseek.balance.total)} left`;
}

function claudeLow(claude: ClaudeSpend | null): boolean {
  return !!claude?.credit && claude.credit.remainingUsd < CLAUDE_LOW_USD;
}

function deepseekLow(deepseek: DeepSeekSpend): boolean {
  return !!deepseek.balance && deepseek.balance.total < DEEPSEEK_LOW_USD;
}

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between gap-4">
    <span className="text-muted-foreground">{label}</span>
    <span className="tabular-nums">{value}</span>
  </div>
);

function ClaudeDetails({ claude }: { claude: ClaudeSpend | null }) {
  if (!claude) {
    return <p>Apply Copilot didn't answer. Try again in a few minutes.</p>;
  }
  return (
    <div className="space-y-1 text-xs">
      <p className="font-medium">Claude (Apply Copilot runs)</p>
      <Row label="Today" value={usd(claude.todayUsd)} />
      <Row label="This month" value={usd(claude.monthUsd)} />
      <Row label="All time" value={usd(claude.totalUsd)} />
      {claude.byModel.map((m) => (
        <Row
          key={m.model}
          label={m.model}
          value={`${usd(m.usd)} · ${m.calls} calls`}
        />
      ))}
      <p className="pt-1 text-muted-foreground">
        {claude.credit
          ? `Left is an estimate: ${usd(claude.credit.amountUsd)} loaded on ${claude.credit.asOf}, minus spend since then.`
          : "Anthropic doesn't share your balance. Enter the credit you loaded in Apply Copilot ⚙ to see what's left."}
      </p>
    </div>
  );
}

function DeepSeekDetails({ deepseek }: { deepseek: DeepSeekSpend }) {
  return (
    <div className="space-y-1 text-xs">
      <p className="font-medium">DeepSeek (job scoring)</p>
      <Row label="Today" value={usd(deepseek.todayUsd)} />
      <Row label="This month" value={usd(deepseek.monthUsd)} />
      {deepseek.byFeature.map((f) => (
        <Row
          key={f.feature ?? "other"}
          label={f.feature ?? "other"}
          value={`${usd(f.usd)} · ${f.calls} calls`}
        />
      ))}
      <p className="pt-1 text-muted-foreground">
        {deepseek.balanceError
          ? `Balance unavailable (${deepseek.balanceError}).`
          : deepseek.calls === 0
            ? "Left is DeepSeek's own balance. Spend is counted from the next scoring run on."
            : "Left is DeepSeek's own balance. Spend is counted from when tracking started."}
      </p>
    </div>
  );
}

const Chip: React.FC<{
  name: string;
  value: string;
  low: boolean;
  details: React.ReactNode;
}> = ({ name, value, low, details }) => (
  <Tip
    content={details}
    side="bottom"
    align="end"
    asChild
    contentClassName="w-72 border border-border/70 bg-popover px-3 py-2 text-popover-foreground shadow-lg"
  >
    <button
      type="button"
      aria-label={`${name}: ${value}${low ? " (running low)" : ""}. Show details`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        low
          ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "text-muted-foreground",
      )}
    >
      <span className="font-medium text-foreground">{name}</span>
      <span>{value}</span>
    </button>
  </Tip>
);

export const AiSpendStrip: React.FC = () => {
  const query = useQuery<AiSpendResponse>({
    queryKey: ["ai-spend"],
    queryFn: () => getAiSpend(),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  // Spend is a side note: no spinner or error banner competing with the job list.
  if (!query.data) return null;
  const { claude, deepseek } = query.data;

  return (
    <section
      aria-label="AI spend"
      className="-mb-3 flex flex-wrap items-center justify-end gap-2"
      data-testid="ai-spend-strip"
    >
      <Chip
        name="Claude"
        value={describeClaude(claude)}
        low={claudeLow(claude)}
        details={<ClaudeDetails claude={claude} />}
      />
      <Chip
        name="DeepSeek"
        value={describeDeepSeek(deepseek)}
        low={deepseekLow(deepseek)}
        details={<DeepSeekDetails deepseek={deepseek} />}
      />
    </section>
  );
};
