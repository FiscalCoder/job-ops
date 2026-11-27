import type { ClaudeAuthStatus } from "@client/api/llm-auth";
import { ExternalLink } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FeedbackText } from "./SubscriptionStateBadge";
import { formatDateTime } from "./status-helpers";

interface ClaudeSignInFlowProps {
  claude: ClaudeAuthStatus;
  disabled: boolean;
  isStarting: boolean;
  isSubmitting: boolean;
  onStart: () => Promise<boolean>;
  onSubmitCode: (code: string) => Promise<boolean>;
}

const CODE_INPUT_ID = "claude-sign-in-code";

export function ClaudeSignInFlow({
  claude,
  disabled,
  isStarting,
  isSubmitting,
  onStart,
  onSubmitCode,
}: ClaudeSignInFlowProps) {
  const [code, setCode] = useState("");
  const login = claude.login;
  const loginEnded = login?.status === "failed" || login?.status === "expired";
  const waitingForCode =
    login?.status === "awaiting_code" || login?.status === "submitting";

  const start = async () => {
    setCode("");
    await onStart();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    const ok = await onSubmitCode(trimmed);
    if (ok) setCode("");
  };

  if (loginEnded) {
    return (
      <div className="space-y-2 rounded-md border border-dashed border-border/70 p-3">
        <FeedbackText
          tone="error"
          message={
            login?.message ??
            (login?.status === "expired"
              ? "The sign-in session timed out."
              : "Claude sign-in failed.")
          }
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void start()}
          disabled={disabled || isStarting}
        >
          {isStarting ? "Starting..." : "Start again"}
        </Button>
      </div>
    );
  }

  if (!login || login.status === "starting") {
    const label = claude.state === "missing" ? "Connect" : "Re-login";
    const busy = isStarting || login?.status === "starting";
    return (
      <Button
        type="button"
        size="sm"
        onClick={() => void start()}
        disabled={disabled || busy}
      >
        {busy ? "Starting sign-in..." : label}
      </Button>
    );
  }

  const sessionEnds = formatDateTime(login.expiresAt);
  return (
    <div className="space-y-3 rounded-md border border-border/70 bg-muted/20 p-3">
      <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
        <li>
          Open the Claude sign-in page and sign in with your Claude account.
        </li>
        <li>Copy the code Anthropic shows you.</li>
        <li>Paste it here and press Submit.</li>
      </ol>
      {login.signInUrl ? (
        <Button type="button" size="sm" variant="outline" asChild>
          <a href={login.signInUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Open Claude sign-in
          </a>
        </Button>
      ) : null}
      {waitingForCode ? (
        <form className="space-y-2" onSubmit={(event) => void submit(event)}>
          <label htmlFor={CODE_INPUT_ID} className="text-xs font-medium">
            Code from Anthropic
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={CODE_INPUT_ID}
              value={code}
              autoComplete="off"
              spellCheck={false}
              className="h-9 max-w-sm font-mono"
              onChange={(event) => setCode(event.target.value)}
              disabled={disabled || isSubmitting}
            />
            <Button
              type="submit"
              size="sm"
              disabled={disabled || isSubmitting || !code.trim()}
            >
              {isSubmitting ? "Checking..." : "Submit"}
            </Button>
          </div>
        </form>
      ) : null}
      <FeedbackText tone="info" message={login.message} />
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {sessionEnds ? <span>Sign-in open until {sessionEnds}.</span> : null}
        <button
          type="button"
          className="underline underline-offset-2 disabled:opacity-60"
          onClick={() => void start()}
          disabled={disabled || isStarting}
        >
          Start again
        </button>
      </div>
    </div>
  );
}
