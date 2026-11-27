import { cn } from "@/lib/utils";
import type { BadgeTone, StateBadgeView } from "./status-helpers";

const TONE_CLASSES: Record<BadgeTone, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  idle: "border-border bg-muted/40 text-muted-foreground",
};

interface SubscriptionStateBadgeProps {
  view: StateBadgeView;
  className?: string;
}

export function SubscriptionStateBadge({
  view,
  className,
}: SubscriptionStateBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[view.tone],
        className,
      )}
    >
      {view.label}
    </span>
  );
}

interface FeedbackTextProps {
  tone: "ok" | "warn" | "error" | "info";
  message: string | null | undefined;
}

const FEEDBACK_CLASSES: Record<FeedbackTextProps["tone"], string> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-destructive",
  info: "text-muted-foreground",
};

export function FeedbackText({ tone, message }: FeedbackTextProps) {
  if (!message) return null;
  return (
    <p
      className={cn("text-xs", FEEDBACK_CLASSES[tone])}
      role={tone === "error" ? "alert" : "status"}
    >
      {message}
    </p>
  );
}
