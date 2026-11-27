import { Button } from "@/components/ui/button";
import { buildAiChain, type ChainStep, type ChainTarget } from "./ai-routing";
import { SubscriptionStateBadge } from "./SubscriptionStateBadge";
import { useSubscriptionAccess } from "./useSubscriptionAccess";
import { useLlmAuthStatusQuery } from "./useSubscriptionAuth";
import { useSubscriptionSettings } from "./useSubscriptionSettings";

/**
 * Fork: one card at the top of Settings → Model that answers "which AI runs
 * my jobs, and what happens when it can't?" — the numbered order Job Ops
 * tries, with real provider names and a jump to where each step is set.
 */
function scrollToTarget(target: ChainTarget): void {
  const element = document.getElementById(target);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  if (element instanceof HTMLElement && element.tabIndex >= 0) {
    element.focus({ preventScroll: true });
  }
}

function StepRow({ step }: { step: ChainStep }) {
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <span
        aria-hidden
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold"
      >
        {step.rank}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {step.role}
          </span>
          <span className="text-sm font-medium">{step.title}</span>
          <SubscriptionStateBadge view={step.badge} />
        </div>
        {step.details.map((line) => (
          <p key={line} className="break-words text-xs text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
      {step.target ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 self-start"
          onClick={() => scrollToTarget(step.target as ChainTarget)}
          aria-label={`Change ${step.role.toLowerCase()}`}
        >
          Change
        </Button>
      ) : null}
    </li>
  );
}

export function AiRoutingSummary() {
  const { subscriptionLoginsAvailable } = useSubscriptionAccess();
  const { settings } = useSubscriptionSettings();
  const authQuery = useLlmAuthStatusQuery(subscriptionLoginsAvailable);
  if (!settings) return null;

  const steps = buildAiChain(settings, authQuery.data);
  return (
    <section
      aria-labelledby="ai-routing-title"
      className="space-y-3 rounded-xl border border-border/70 bg-muted/10 p-4"
    >
      <div className="space-y-1">
        <h3 id="ai-routing-title" className="text-sm font-semibold">
          How Job Ops picks an AI
        </h3>
        <p className="text-xs text-muted-foreground">
          Every AI task (scoring, tailoring, email sorting) tries these in order
          and moves to the next only when the one before is out of usage or not
          connected.
        </p>
      </div>
      <ol className="divide-y divide-border/60">
        {steps.map((step) => (
          <StepRow key={step.role} step={step} />
        ))}
      </ol>
      <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
        Shows your saved settings. Change a step in its section below, then
        save.
      </p>
    </section>
  );
}
