/**
 * Fork-only: syncs every connected Gmail account on a timer so the tracking
 * inbox stays current without pressing "Sync".
 */

import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { isDemoMode } from "@server/config/demo";
import { db, schema } from "@server/db/index";
import { and, eq, ne } from "drizzle-orm";
import { executePostApplicationProviderAction } from "../providers/service";

const { postApplicationIntegrations } = schema;

const DEFAULT_INTERVAL_MINUTES = 60;
// A short window keeps each run cheap; already-seen messages are skipped anyway.
const AUTO_SYNC_SEARCH_DAYS = 3;

export interface GmailAccountScope {
  tenantId: string;
  userId: string | null;
  accountKey: string;
}

async function listGmailAccounts(): Promise<GmailAccountScope[]> {
  return db
    .select({
      tenantId: postApplicationIntegrations.tenantId,
      userId: postApplicationIntegrations.userId,
      accountKey: postApplicationIntegrations.accountKey,
    })
    .from(postApplicationIntegrations)
    .where(
      and(
        eq(postApplicationIntegrations.provider, "gmail"),
        ne(postApplicationIntegrations.status, "disconnected"),
      ),
    );
}

/** Sync each account in its own tenant/user scope; one failure doesn't stop the rest. */
export async function syncGmailAccounts(
  accounts: readonly GmailAccountScope[],
): Promise<void> {
  for (const account of accounts) {
    try {
      await runWithRequestContext(
        { tenantId: account.tenantId, userId: account.userId ?? undefined },
        () =>
          executePostApplicationProviderAction({
            provider: "gmail",
            action: "sync",
            accountKey: account.accountKey,
            syncPayload: { searchDays: AUTO_SYNC_SEARCH_DAYS },
            initiatedBy: null,
          }),
      );
    } catch (error) {
      logger.warn("Scheduled Gmail sync failed", {
        tenantId: account.tenantId,
        accountKey: account.accountKey,
        error: sanitizeUnknown(error),
      });
    }
  }
}

let running = false;

async function runScheduledSync(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await syncGmailAccounts(await listGmailAccounts());
  } catch (error) {
    logger.warn("Scheduled Gmail sync could not list accounts", {
      error: sanitizeUnknown(error),
    });
  } finally {
    running = false;
  }
}

/** Start the periodic sync. GMAIL_AUTO_SYNC_MINUTES=0 turns it off. */
export function initializeGmailAutoSync(): void {
  const parsed = Number.parseInt(process.env.GMAIL_AUTO_SYNC_MINUTES ?? "", 10);
  const minutes = Number.isNaN(parsed) ? DEFAULT_INTERVAL_MINUTES : parsed;
  if (minutes <= 0 || isDemoMode()) {
    logger.info("Scheduled Gmail sync is disabled");
    return;
  }
  setInterval(() => void runScheduledSync(), minutes * 60 * 1000);
  logger.info("Scheduled Gmail sync started", { everyMinutes: minutes });
}
