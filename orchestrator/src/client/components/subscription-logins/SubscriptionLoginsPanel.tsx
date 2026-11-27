import { Loader2 } from "lucide-react";
import { ClaudeSubscriptionCard } from "./ClaudeSubscriptionCard";
import { CodexSubscriptionCard } from "./CodexSubscriptionCard";
import { SubscriptionPreferences } from "./SubscriptionPreferences";
import { FeedbackText } from "./SubscriptionStateBadge";
import { SubscriptionTaskRouting } from "./SubscriptionTaskRouting";
import { usesClaudeSubscription } from "./task-routing";
import { useSubscriptionAccess } from "./useSubscriptionAccess";
import { useSubscriptionAuth } from "./useSubscriptionAuth";
import { useSubscriptionSettings } from "./useSubscriptionSettings";

export const SUBSCRIPTION_LOGINS_ANCHOR_ID = "subscription-logins";

interface SubscriptionLoginsPanelProps {
  disabled?: boolean;
}

export function SubscriptionLoginsPanel({
  disabled = false,
}: SubscriptionLoginsPanelProps) {
  const { subscriptionLoginsAvailable } = useSubscriptionAccess();
  const controller = useSubscriptionAuth({
    enabled: subscriptionLoginsAvailable,
  });
  const settingsController = useSubscriptionSettings();

  if (!subscriptionLoginsAvailable) return null;

  const { status } = controller;
  const claudeConnected = status?.claude.connected ?? false;
  const codexConnected = status?.codex.connected ?? false;
  const anyConnected = claudeConnected || codexConnected;
  const showEffort =
    claudeConnected || usesClaudeSubscription(settingsController.settings);

  return (
    <section
      id={SUBSCRIPTION_LOGINS_ANCHOR_ID}
      aria-labelledby="subscription-logins-title"
      className="scroll-mt-24 space-y-4 rounded-xl border border-border/70 bg-muted/10 p-4"
    >
      <div className="space-y-1">
        <h3 id="subscription-logins-title" className="text-sm font-semibold">
          Subscription logins
        </h3>
        <p className="text-xs text-muted-foreground">
          Connect your own Claude or ChatGPT plan so Job Ops runs your tasks on
          it instead of an API key.
        </p>
      </div>

      {controller.isLoading ? (
        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Checking your logins...
        </div>
      ) : null}
      <FeedbackText tone="error" message={controller.loadError} />

      {status ? (
        <div className="grid gap-3 xl:grid-cols-2">
          <ClaudeSubscriptionCard
            claude={status.claude}
            controller={controller}
            disabled={disabled}
          />
          <CodexSubscriptionCard
            codex={status.codex}
            controller={controller}
            disabled={disabled}
          />
        </div>
      ) : null}

      {status && anyConnected ? (
        <SubscriptionTaskRouting
          connected={{ claude_cli: claudeConnected, codex: codexConnected }}
          settingsController={settingsController}
          disabled={disabled}
        />
      ) : null}

      {status ? (
        <SubscriptionPreferences
          showFallback={status.subscriptionFallback.available}
          fallbackEnabled={status.subscriptionFallback.enabled}
          showEffort={showEffort}
          settingsController={settingsController}
          disabled={disabled}
        />
      ) : null}
      {settingsController.isSaving ? (
        <p className="text-xs text-muted-foreground">Saving...</p>
      ) : null}
      <FeedbackText tone="error" message={settingsController.saveError} />

      <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
        Logins are stored on the Job Ops server for your account only and are
        used only for your own searches, scoring and tailoring.
      </p>
    </section>
  );
}
