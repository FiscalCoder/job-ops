import type { DatabaseSync } from "node:sqlite";
import type { PageMap, PageMapStore } from "../claude/page-map.js";

/**
 * Claude's page maps by layout key (user and page layout), so a restart or deploy doesn't pay
 * for the same form again. The mapper checks a kept map's shape before using it.
 */
export function createPageMapsRepo(db: DatabaseSync): PageMapStore {
  const read = db.prepare("select map_json from page_maps where cache_key = ?");
  const write = db.prepare(
    `insert into page_maps (cache_key, map_json) values (?, ?)
     on conflict(cache_key) do update set map_json = excluded.map_json, created_at = datetime('now')`,
  );
  return {
    get(key: string): unknown {
      const row = read.get(key) as { map_json: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.map_json) as unknown;
      } catch {
        return null;
      }
    },
    set(key: string, map: PageMap): void {
      write.run(key, JSON.stringify(map));
    },
  };
}
