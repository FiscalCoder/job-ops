import { count, eq } from "drizzle-orm";
import { db, schema } from "../db";

const { tenantMemberships } = schema;

/** Fork: number of users who belong to a tenant (workspace). */
export async function countTenantMembers(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ members: count() })
    .from(tenantMemberships)
    .where(eq(tenantMemberships.tenantId, tenantId));
  return row?.members ?? 0;
}
