import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";

export interface SubscriptionAccess {
  /** Subscription logins exist only on self-hosted installs. */
  subscriptionLoginsAvailable: boolean;
  /**
   * Non-admins on a self-hosted install may only point their AI settings at
   * their own subscriptions; API providers, base URLs and keys stay with the
   * workspace admin.
   */
  lockApiProviderSettings: boolean;
}

export function useSubscriptionAccess(): SubscriptionAccess {
  const appStatusQuery = useQuery({
    queryKey: queryKeys.app.status(),
    queryFn: api.getAppStatus,
  });
  const currentUserQuery = useQuery({
    queryKey: queryKeys.auth.currentUser(),
    queryFn: api.getCurrentAuthUser,
    retry: false,
  });
  const appMode = appStatusQuery.data?.appMode;
  const isSelfHosted = appMode !== undefined && appMode !== "hosted";
  return {
    subscriptionLoginsAvailable: isSelfHosted,
    lockApiProviderSettings:
      isSelfHosted && currentUserQuery.data?.isSystemAdmin === false,
  };
}
