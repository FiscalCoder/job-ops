import type { CodexAuthConnectionStatus } from "@client/api/llm-auth";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DisconnectButton } from "./DisconnectButton";
import { SubscriptionCardShell } from "./SubscriptionCardShell";
import { FeedbackText } from "./SubscriptionStateBadge";
import {
  formatDateTime,
  getCodexBadge,
  isCodexLoginActive,
  mentionsDeviceCodeSetting,
} from "./status-helpers";
import type { SubscriptionAuthController } from "./useSubscriptionAuth";

const COPY_FEEDBACK_MS = 1_800;

interface CodexSubscriptionCardProps {
  codex: CodexAuthConnectionStatus;
  controller: SubscriptionAuthController;
  disabled?: boolean;
}

function useCopyFeedback(): [boolean, (value: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return [copied, copy];
}

function DeviceCodeSettingHint() {
  return (
    <p className="text-xs text-muted-foreground">
      Device-code login must be turned on first: in ChatGPT open Settings →
      Security, enable device code authorization for Codex, then start again.
    </p>
  );
}

export function CodexSubscriptionCard({
  codex,
  controller,
  disabled = false,
}: CodexSubscriptionCardProps) {
  const { pendingAction } = controller;
  const busy = disabled || pendingAction !== null;
  const [copied, copy] = useCopyFeedback();
  const login = codex.login;
  const loginActive = isCodexLoginActive(codex);
  const loginFailed = login?.status === "failed";
  const lastRefreshed = formatDateTime(codex.lastRefreshAt);
  const feedback = controller.feedback.codex;
  const showDeviceHint =
    mentionsDeviceCodeSetting(login?.message) ||
    mentionsDeviceCodeSetting(feedback?.message);
  const startLabel = codex.state === "missing" ? "Connect" : "Re-login";

  return (
    <SubscriptionCardShell
      title="ChatGPT subscription"
      subtitle={
        lastRefreshed
          ? `Last refreshed ${lastRefreshed}`
          : "Use your ChatGPT plan (through Codex) for Job Ops tasks."
      }
      badge={getCodexBadge(codex)}
      testId="codex-subscription-card"
    >
      {loginActive && login ? (
        <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
          <div className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {login.userCode ? "Waiting for approval" : "Starting sign-in..."}
          </div>
          {login.userCode ? (
            <>
              <p className="text-xs text-muted-foreground">
                Open the ChatGPT page, sign in, and enter this one-time code.
              </p>
              <div className="font-mono text-xl font-semibold tracking-widest">
                {login.userCode}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void copy(login.userCode ?? "")}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  {copied ? "Copied" : "Copy code"}
                </Button>
                {login.verificationUrl ? (
                  <Button type="button" size="sm" variant="outline" asChild>
                    <a
                      href={login.verificationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      Open ChatGPT sign-in
                    </a>
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
          <FeedbackText tone="info" message={login.message} />
        </div>
      ) : null}
      {loginFailed ? (
        <FeedbackText
          tone="error"
          message={login?.message ?? "ChatGPT sign-in failed."}
        />
      ) : null}
      {showDeviceHint ? <DeviceCodeSettingHint /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={loginActive ? "outline" : "default"}
          disabled={busy}
          onClick={() => void controller.startCodex(loginActive || loginFailed)}
        >
          {pendingAction === "codexStart"
            ? "Starting..."
            : loginActive || loginFailed
              ? "Start again"
              : startLabel}
        </Button>
        {codex.state !== "missing" ? (
          <DisconnectButton
            providerLabel="ChatGPT"
            disabled={busy}
            isPending={pendingAction === "codexDisconnect"}
            onConfirm={() => void controller.disconnectCodex()}
          />
        ) : null}
      </div>
      {feedback ? (
        <FeedbackText tone={feedback.tone} message={feedback.message} />
      ) : null}
    </SubscriptionCardShell>
  );
}
