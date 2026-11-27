import type { LlmAuthStatus } from "@client/api/llm-auth";
import * as authApi from "@client/api/llm-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { getErrorMessage, getPollInterval } from "./status-helpers";

export const LLM_AUTH_STATUS_QUERY_KEY = ["llm-auth", "status"] as const;

export type SubscriptionProvider = "claude" | "codex";

export type SubscriptionAction =
  | "claudeStart"
  | "claudeCode"
  | "claudeToken"
  | "claudeTest"
  | "claudeDisconnect"
  | "codexStart"
  | "codexDisconnect";

export interface ActionFeedback {
  tone: "ok" | "warn" | "error";
  message: string;
}

type FeedbackMap = Readonly<
  Partial<Record<SubscriptionProvider, ActionFeedback | null>>
>;

interface UseSubscriptionAuthOptions {
  enabled?: boolean;
}

export interface SubscriptionAuthController {
  status: LlmAuthStatus | undefined;
  isLoading: boolean;
  loadError: string | null;
  pendingAction: SubscriptionAction | null;
  feedback: FeedbackMap;
  clearFeedback: (provider: SubscriptionProvider) => void;
  refresh: () => Promise<void>;
  startClaude: () => Promise<boolean>;
  submitClaudeCode: (code: string) => Promise<boolean>;
  saveClaudeToken: (token: string) => Promise<boolean>;
  testClaude: () => Promise<void>;
  disconnectClaude: () => Promise<boolean>;
  startCodex: (forceRestart?: boolean) => Promise<boolean>;
  disconnectCodex: () => Promise<boolean>;
}

/** Shared read-only view of the caller's subscription logins. */
export function useLlmAuthStatusQuery(enabled = true) {
  return useQuery({
    queryKey: LLM_AUTH_STATUS_QUERY_KEY,
    queryFn: authApi.getLlmAuthStatus,
    enabled,
    retry: false,
    refetchInterval: (query) => getPollInterval(query.state.data),
  });
}

const ACTION_PROVIDER: Record<SubscriptionAction, SubscriptionProvider> = {
  claudeStart: "claude",
  claudeCode: "claude",
  claudeToken: "claude",
  claudeTest: "claude",
  claudeDisconnect: "claude",
  codexStart: "codex",
  codexDisconnect: "codex",
};

export function useSubscriptionAuth(
  options: UseSubscriptionAuthOptions = {},
): SubscriptionAuthController {
  const queryClient = useQueryClient();
  const query = useLlmAuthStatusQuery(options.enabled ?? true);
  const [pendingAction, setPendingAction] = useState<SubscriptionAction | null>(
    null,
  );
  const [feedback, setFeedback] = useState<FeedbackMap>({});

  const setProviderFeedback = useCallback(
    (provider: SubscriptionProvider, next: ActionFeedback | null) => {
      setFeedback((current) => ({ ...current, [provider]: next }));
    },
    [],
  );

  const runStatusAction = useCallback(
    async <T extends LlmAuthStatus>(
      action: SubscriptionAction,
      call: () => Promise<T>,
      fallbackError: string,
      onSuccess?: (result: T) => ActionFeedback | null,
    ): Promise<boolean> => {
      const provider = ACTION_PROVIDER[action];
      setPendingAction(action);
      setProviderFeedback(provider, null);
      try {
        const result = await call();
        const { claude, codex, subscriptionFallback } = result;
        queryClient.setQueryData<LlmAuthStatus>(LLM_AUTH_STATUS_QUERY_KEY, {
          claude,
          codex,
          subscriptionFallback,
        });
        setProviderFeedback(provider, onSuccess?.(result) ?? null);
        return true;
      } catch (error) {
        setProviderFeedback(provider, {
          tone: "error",
          message: getErrorMessage(error, fallbackError),
        });
        return false;
      } finally {
        setPendingAction(null);
      }
    },
    [queryClient, setProviderFeedback],
  );

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: LLM_AUTH_STATUS_QUERY_KEY,
    });
  }, [queryClient]);

  const testClaude = useCallback(async () => {
    setPendingAction("claudeTest");
    setProviderFeedback("claude", null);
    try {
      const result = await authApi.testClaudeConnection();
      setProviderFeedback("claude", {
        tone: result.ok ? "ok" : "warn",
        message: result.message,
      });
    } catch (error) {
      setProviderFeedback("claude", {
        tone: "error",
        message: getErrorMessage(error, "Could not test the Claude login."),
      });
    } finally {
      setPendingAction(null);
    }
  }, [setProviderFeedback]);

  return {
    status: query.data,
    isLoading: query.isLoading,
    loadError: query.error
      ? getErrorMessage(query.error, "Could not load subscription logins.")
      : null,
    pendingAction,
    feedback,
    clearFeedback: (provider) => setProviderFeedback(provider, null),
    refresh,
    startClaude: () =>
      runStatusAction(
        "claudeStart",
        authApi.startClaudeLogin,
        "Could not start Claude sign-in.",
      ),
    submitClaudeCode: (code) =>
      runStatusAction(
        "claudeCode",
        () => authApi.submitClaudeLoginCode(code),
        "Code rejected or expired — start again.",
        ({ verification }) => {
          if (!verification) {
            return { tone: "ok", message: "Claude subscription connected." };
          }
          return verification.ok
            ? { tone: "ok", message: "Connected and tested." }
            : { tone: "warn", message: verification.message };
        },
      ),
    saveClaudeToken: (token) =>
      runStatusAction(
        "claudeToken",
        () => authApi.saveClaudeToken(token),
        "That token could not be saved.",
        () => ({ tone: "ok", message: "Token saved." }),
      ),
    testClaude,
    disconnectClaude: () =>
      runStatusAction(
        "claudeDisconnect",
        authApi.disconnectClaude,
        "Could not disconnect Claude right now.",
      ),
    startCodex: (forceRestart = false) =>
      runStatusAction(
        "codexStart",
        () => authApi.startCodexLogin({ forceRestart }),
        "Could not start ChatGPT sign-in.",
      ),
    disconnectCodex: () =>
      runStatusAction(
        "codexDisconnect",
        authApi.disconnectCodex,
        "Could not disconnect ChatGPT right now.",
      ),
  };
}
