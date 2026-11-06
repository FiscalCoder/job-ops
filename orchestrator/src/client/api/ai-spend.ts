import { fetchApi } from "./core";

export interface ClaudeSpend {
  totalUsd: number;
  monthUsd: number;
  todayUsd: number;
  calls: number;
  unpriced: number;
  byModel: Array<{ model: string; usd: number; calls: number }>;
  since: string | null;
  credit: null | {
    amountUsd: number;
    asOf: string;
    spentSinceUsd: number;
    remainingUsd: number;
  };
}

export interface DeepSeekSpend {
  trackedUsd: number;
  monthUsd: number;
  todayUsd: number;
  calls: number;
  since: string | null;
  byFeature: Array<{ feature: string | null; usd: number; calls: number }>;
  balance: null | {
    currency: string;
    total: number;
    granted: number;
    toppedUp: number;
    isAvailable: boolean;
  };
  balanceError?: string;
}

export interface AiSpendResponse {
  claude: ClaudeSpend | null;
  deepseek: DeepSeekSpend;
}

export async function getAiSpend(): Promise<AiSpendResponse> {
  return fetchApi<AiSpendResponse>("/ai-spend");
}
