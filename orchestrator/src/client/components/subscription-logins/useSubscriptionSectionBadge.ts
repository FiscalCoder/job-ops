import type { SectionWorkspaceBadge } from "@client/components/section-workspace/SectionWorkspace";
import { needsAttention } from "./status-helpers";
import { useSubscriptionAccess } from "./useSubscriptionAccess";
import { useLlmAuthStatusQuery } from "./useSubscriptionAuth";

/** Badge for the Settings AI section when a subscription login needs work. */
export function useSubscriptionSectionBadge(): SectionWorkspaceBadge | null {
  const { subscriptionLoginsAvailable } = useSubscriptionAccess();
  const { data } = useLlmAuthStatusQuery(subscriptionLoginsAvailable);
  const attention = subscriptionLoginsAvailable ? needsAttention(data) : null;
  if (!attention) return null;
  return {
    label: attention.label,
    variant: attention.tone === "error" ? "destructive" : "secondary",
  };
}
