import type { DatabaseSync } from "node:sqlite";
import { employerKey } from "../resolver/text.js";

/** A company that takes only so many applications from you in a while. */
export interface CompanyLimit {
  readonly id: number;
  /** employerKey() of its name: matches "Amazon", "Amazon Development Centre India", ... */
  readonly companyKey: string;
  readonly name: string;
  readonly maxApplications: number;
  readonly windowDays: number;
  readonly note: string;
}

interface Row {
  id: number;
  company_key: string;
  name: string;
  max_applications: number;
  window_days: number;
  note: string;
}

const toLimit = (row: Row): CompanyLimit => ({
  id: row.id,
  companyKey: row.company_key,
  name: row.name,
  maxApplications: row.max_applications,
  windowDays: row.window_days,
  note: row.note,
});

export function createCompanyLimitsRepo(db: DatabaseSync) {
  const upsertStmt = db.prepare(
    `insert into company_limits (company_key, name, max_applications, window_days, note)
     values (?, ?, ?, ?, ?)
     on conflict(company_key) do update set name = excluded.name,
       max_applications = excluded.max_applications, window_days = excluded.window_days,
       note = excluded.note, updated_at = datetime('now')`,
  );
  const byKey = db.prepare("select * from company_limits where company_key = ?");
  const all = db.prepare("select * from company_limits order by name");
  const remove = db.prepare("delete from company_limits where id = ?");

  return {
    list(): CompanyLimit[] {
      return (all.all() as unknown as Row[]).map(toLimit);
    },
    save(input: {
      name: string;
      maxApplications: number;
      windowDays: number;
      note: string;
    }): CompanyLimit {
      const key = employerKey(input.name);
      upsertStmt.run(key, input.name, input.maxApplications, input.windowDays, input.note);
      return toLimit(byKey.get(key) as unknown as Row);
    },
    /** True when something was deleted. */
    delete(id: number): boolean {
      return Number(remove.run(id).changes) > 0;
    },
  };
}

export type CompanyLimitsRepo = ReturnType<typeof createCompanyLimitsRepo>;
