import { createHash } from "node:crypto";
import { getPrivateDataScope } from "@server/tenancy/private-scope";
import { resolveLlmRuntimeSettings } from "../modelSelection";
import { type DeepSeekBalance, getDeepSeekBalance } from "./deepseek-balance";
import {
  type DeepSeekTrackedSpend,
  getDeepSeekTrackedSpend,
} from "./usage-summary";

/** Job Ops' own LLM spend (DeepSeek scoring and tailoring). Claude's is apply-assistant's. */
export interface AiSpendResponse {
  deepseek: DeepSeekTrackedSpend & {
    balance: DeepSeekBalance | null;
    balanceError?: string;
  };
}

/**
 * One cache entry per user and key: in local mode the scope key is only the tenant, though
 * several users share the server with their own LLM keys. The key itself is only hashed.
 */
function balanceCacheKey(apiKey: string | null | undefined): string {
  const { tenantId, userId } = getPrivateDataScope();
  const keyHash = createHash("sha256")
    .update(apiKey ?? "")
    .digest("hex")
    .slice(0, 16);
  return `${tenantId}:${userId ?? "-"}:${keyHash}`;
}

async function loadBalance(): Promise<{
  balance: DeepSeekBalance | null;
  error?: string;
}> {
  try {
    const runtime = await resolveLlmRuntimeSettings("default");
    return await getDeepSeekBalance({
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      cacheKey: balanceCacheKey(runtime.apiKey),
    });
  } catch {
    return { balance: null, error: "settings unavailable" };
  }
}

export async function getAiSpend(): Promise<AiSpendResponse> {
  const [tracked, balance] = await Promise.all([
    getDeepSeekTrackedSpend(),
    loadBalance(),
  ]);
  return {
    deepseek: {
      ...tracked,
      balance: balance.balance,
      ...(balance.error ? { balanceError: balance.error } : {}),
    },
  };
}
