import type { ClaudeAuthStatus } from "@client/api/llm-auth";
import { Button } from "@/components/ui/button";
import { ClaudeSignInFlow } from "./ClaudeSignInFlow";
import { ClaudeTokenFallback } from "./ClaudeTokenFallback";
import { DisconnectButton } from "./DisconnectButton";
import { SubscriptionCardShell } from "./SubscriptionCardShell";
import { FeedbackText } from "./SubscriptionStateBadge";
import {
  formatDate,
  getClaudeBadge,
  getClaudeSourceLabel,
} from "./status-helpers";
import type { SubscriptionAuthController } from "./useSubscriptionAuth";

interface ClaudeSubscriptionCardProps {
  claude: ClaudeAuthStatus;
  controller: SubscriptionAuthController;
  disabled?: boolean;
}

function ClaudeSubtitle({ claude }: { claude: ClaudeAuthStatus }) {
  const source = getClaudeSourceLabel(claude.source);
  const created = formatDate(claude.createdAt);
  if (!source && !created) {
    return <>Use your Claude Pro or Max plan for Job Ops tasks.</>;
  }
  return (
    <>
      {[source, created ? `added ${created}` : null]
        .filter(Boolean)
        .join(" · ")}
    </>
  );
}

export function ClaudeSubscriptionCard({
  claude,
  controller,
  disabled = false,
}: ClaudeSubscriptionCardProps) {
  const { pendingAction } = controller;
  const busy = disabled || pendingAction !== null;
  const hasSavedLogin = claude.state !== "missing";
  const feedback = controller.feedback.claude;

  return (
    <SubscriptionCardShell
      title="Claude subscription"
      subtitle={<ClaudeSubtitle claude={claude} />}
      badge={getClaudeBadge(claude)}
      testId="claude-subscription-card"
    >
      {claude.state === "expired" ? (
        <FeedbackText
          tone="error"
          message="Your Claude login has expired. Re-login to keep using it."
        />
      ) : null}
      <ClaudeSignInFlow
        claude={claude}
        disabled={busy}
        isStarting={pendingAction === "claudeStart"}
        isSubmitting={pendingAction === "claudeCode"}
        onStart={controller.startClaude}
        onSubmitCode={controller.submitClaudeCode}
      />
      <ClaudeTokenFallback
        disabled={busy}
        isSaving={pendingAction === "claudeToken"}
        onSave={controller.saveClaudeToken}
      />
      {hasSavedLogin ? (
        <div className="flex flex-wrap items-center gap-2">
          {claude.connected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void controller.testClaude()}
            >
              {pendingAction === "claudeTest"
                ? "Testing..."
                : "Test connection"}
            </Button>
          ) : null}
          <DisconnectButton
            providerLabel="Claude"
            disabled={busy}
            isPending={pendingAction === "claudeDisconnect"}
            onConfirm={() => void controller.disconnectClaude()}
          />
        </div>
      ) : null}
      {feedback ? (
        <FeedbackText tone={feedback.tone} message={feedback.message} />
      ) : null}
    </SubscriptionCardShell>
  );
}
