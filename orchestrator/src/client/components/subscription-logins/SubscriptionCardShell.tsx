import type React from "react";
import { SubscriptionStateBadge } from "./SubscriptionStateBadge";
import type { StateBadgeView } from "./status-helpers";

interface SubscriptionCardShellProps {
  title: string;
  subtitle?: React.ReactNode;
  badge: StateBadgeView;
  children: React.ReactNode;
  testId?: string;
}

export function SubscriptionCardShell({
  title,
  subtitle,
  badge,
  children,
  testId,
}: SubscriptionCardShellProps) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className="space-y-3 rounded-lg border border-border/70 bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h4 className="text-sm font-semibold">{title}</h4>
          {subtitle ? (
            <div className="text-xs text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
        <SubscriptionStateBadge view={badge} />
      </div>
      {children}
    </section>
  );
}
