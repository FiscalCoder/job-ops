import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listCareerBoardSources } from "./career-boards";

/** The fork's company lists (Lever, SmartRecruiters, Keka, Zoho Recruit): every entry must load. */
const FORK_BOARDS = [
  "lever",
  "smartrecruiters",
  "keka",
  "zoho-recruit",
] as const;

describe("fork career-board catalogs", () => {
  it("loads every listed company, with unique ids", async () => {
    const sources = await listCareerBoardSources();
    for (const type of FORK_BOARDS) {
      const listed = JSON.parse(
        readFileSync(join(__dirname, `career-boards-${type}.json`), "utf8"),
      ) as unknown[];
      const loaded = sources.filter((source) => source.sourceType === type);
      expect(listed.length).toBeGreaterThan(0);
      expect(loaded).toHaveLength(listed.length);
    }
    const ids = sources.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
