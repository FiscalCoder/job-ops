import * as api from "@client/api";
import { useUpdateSettingsMutation } from "@client/hooks/queries/useSettingsMutation";
import { queryKeys } from "@client/lib/queryKeys";
import type { UpdateSettingsInput } from "@shared/settings-schema";
import type { AppSettings } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { getErrorMessage } from "./status-helpers";
import { LLM_AUTH_STATUS_QUERY_KEY } from "./useSubscriptionAuth";

export interface SubscriptionSettingsController {
  settings: AppSettings | undefined;
  isSaving: boolean;
  saveError: string | null;
  save: (patch: Partial<UpdateSettingsInput>) => Promise<boolean>;
}

/**
 * Saves subscription choices straight away with only subscription keys, so
 * non-admins (who cannot save the full settings form) can use them too.
 * The server's message is shown as-is when it refuses a change.
 */
export function useSubscriptionSettings(): SubscriptionSettingsController {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings.current(),
    queryFn: api.getSettings,
  });
  const { mutateAsync, isPending } = useUpdateSettingsMutation();
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useCallback(
    async (patch: Partial<UpdateSettingsInput>) => {
      setSaveError(null);
      try {
        await mutateAsync(patch as UpdateSettingsInput);
        await queryClient.invalidateQueries({
          queryKey: LLM_AUTH_STATUS_QUERY_KEY,
        });
        return true;
      } catch (error) {
        setSaveError(getErrorMessage(error, "Could not save this change."));
        return false;
      }
    },
    [mutateAsync, queryClient],
  );

  return {
    settings: settingsQuery.data,
    isSaving: isPending,
    saveError,
    save,
  };
}
