import { db, schema } from "@server/db";
import {
  getPrivateDataScope,
  privateDataScopeFilter,
} from "@server/tenancy/private-scope";
import { and, eq, gte, type SQL, sql } from "drizzle-orm";

const { llmUsage } = schema;

export interface DeepSeekFeatureSpend {
  feature: string | null;
  usd: number;
  calls: number;
}

export interface DeepSeekTrackedSpend {
  trackedUsd: number;
  monthUsd: number;
  todayUsd: number;
  calls: number;
  since: string | null;
  byFeature: DeepSeekFeatureSpend[];
}

const DEEPSEEK_HOST_FILTER = sql`${llmUsage.host} = 'api.deepseek.com'`;

/**
 * The tenant scope, narrowed to the signed-in user whenever one is known: in local mode the
 * scope is the tenant only, but several users share one server and each has their own LLM key.
 */
function ownUsage(): SQL {
  const scope = privateDataScopeFilter(llmUsage);
  const userId = getPrivateDataScope().userId;
  return userId ? (and(scope, eq(llmUsage.userId, userId)) as SQL) : scope;
}

async function sumSince(
  fromIso: string | null,
): Promise<{ usd: number; calls: number; since: string | null }> {
  const scope = ownUsage();
  const where = fromIso
    ? and(scope, DEEPSEEK_HOST_FILTER, gte(llmUsage.createdAt, fromIso))
    : and(scope, DEEPSEEK_HOST_FILTER);
  const [row] = await db
    .select({
      usd: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)`,
      calls: sql<number>`count(*)`,
      since: sql<string | null>`min(${llmUsage.createdAt})`,
    })
    .from(llmUsage)
    .where(where);
  return {
    usd: Number(row?.usd ?? 0),
    calls: Number(row?.calls ?? 0),
    since: row?.since ?? null,
  };
}

async function byFeature(): Promise<DeepSeekFeatureSpend[]> {
  const rows = await db
    .select({
      feature: llmUsage.feature,
      usd: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)`,
      calls: sql<number>`count(*)`,
    })
    .from(llmUsage)
    .where(and(ownUsage(), DEEPSEEK_HOST_FILTER))
    .groupBy(llmUsage.feature);
  return rows
    .map((r) => ({
      feature: r.feature,
      usd: Number(r.usd),
      calls: Number(r.calls),
    }))
    .sort((a, b) => b.usd - a.usd);
}

export async function getDeepSeekTrackedSpend(
  now: Date = new Date(),
): Promise<DeepSeekTrackedSpend> {
  const iso = now.toISOString();
  const monthStart = `${iso.slice(0, 7)}-01T00:00:00.000Z`;
  const dayStart = `${iso.slice(0, 10)}T00:00:00.000Z`;
  const [all, month, today, features] = await Promise.all([
    sumSince(null),
    sumSince(monthStart),
    sumSince(dayStart),
    byFeature(),
  ]);
  return {
    trackedUsd: all.usd,
    monthUsd: month.usd,
    todayUsd: today.usd,
    calls: all.calls,
    since: all.since,
    byFeature: features,
  };
}
