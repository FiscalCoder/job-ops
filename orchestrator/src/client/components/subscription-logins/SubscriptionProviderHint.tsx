import type React from "react";
import { ClaudeSubscriptionCard } from "./ClaudeSubscriptionCard";
import { CodexSubscriptionCard } from "./CodexSubscriptionCard";
import { SUBSCRIPTION_LOGINS_ANCHOR_ID } from "./SubscriptionLoginsPanel";
import { SubscriptionStateBadge } from "./SubscriptionStateBadge";
import { getClaudeBadge, getCodexBadge } from "./status-helpers";
import { useSubscriptionAccess } from "./useSubscriptionAccess";
import {
  type SubscriptionProvider,
  useLlmAuthStatusQuery,
  useSubscriptionAuth,
} from "./useSubscriptionAuth";

const SETTINGS_HREF = "/settings#model";

const PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  claude: "Claude subscription",
  codex: "ChatGPT subscription",
};

interface SubscriptionProviderHintProps {
  provider: SubscriptionProvider;
  /** "link" points at the Subscription logins panel on the same page;
   * "inline" renders the full login card (used where the panel is absent). */
  variant?: "link" | "inline";
}

function scrollToPanel(event: React.MouseEvent<HTMLAnchorElement>): void {
  const panel = document.getElementById(SUBSCRIPTION_LOGINS_ANCHOR_ID);
  if (!panel) return;
  event.preventDefault();
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function InlineCard({ provider }: { provider: SubscriptionProvider }) {
  const controller = useSubscriptionAuth();
  const { status } = controller;
  if (!status) return null;
  return provider === "claude" ? (
    <ClaudeSubscriptionCard claude={status.claude} controller={controller} />
  ) : (
    <CodexSubscriptionCard codex={status.codex} controller={controller} />
  );
}

function StatusLink({ provider }: { provider: SubscriptionProvider }) {
  const { data: status } = useLlmAuthStatusQuery();
  const badge = status
    ? provider === "claude"
      ? getClaudeBadge(status.claude)
      : getCodexBadge(status.codex)
    : null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
      data-testid={`subscription-hint-${provider}`}
    >
      <span className="font-medium text-foreground">
        {PROVIDER_NAMES[provider]}
      </span>
      {badge ? <SubscriptionStateBadge view={badge} /> : null}
      <a
        href={SETTINGS_HREF}
        onClick={scrollToPanel}
        className="text-foreground underline underline-offset-2"
      >
        Manage in Subscription logins
      </a>
    </div>
  );
}

/** Compact stand-in for the old per-provider setup hints. */
export function SubscriptionProviderHint({
  provider,
  variant = "link",
}: SubscriptionProviderHintProps) {
  const { subscriptionLoginsAvailable } = useSubscriptionAccess();
  if (!subscriptionLoginsAvailable) return null;
  return variant === "inline" ? (
    <InlineCard provider={provider} />
  ) : (
    <StatusLink provider={provider} />
  );
}
