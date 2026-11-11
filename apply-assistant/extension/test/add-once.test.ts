import { describe, expect, it, vi } from "vitest";
import { GenericDriver } from "../src/fill/generic-driver";

/**
 * PeopleStrong (L&T, 2026-11-11): "Add Earlier Education" opens a form that never reads as a new
 * block, so every re-plan asked for 2 more and "Add" was clicked again every few seconds.
 */
describe("Add on a company's page", () => {
  it("is used once per section and page in a run, however often the page is planned", async () => {
    let url = "https://larsentoubrocareers.peoplestrong.com/profile/update";
    const page = { url: () => url } as never;
    const frame = { evaluate: async () => null, detached: false } as never;
    const driver = GenericDriver.on({ page, frame });
    let blocks = 0;
    const click = vi.fn(async () => {
      blocks++;
    });
    const internals = driver as unknown as {
      blockCount: (s: string) => Promise<number>;
      addButton: (s: string) => Promise<{ click: () => Promise<void> } | null>;
      findFormFrame: () => Promise<boolean>;
    };
    internals.blockCount = async () => blocks;
    internals.addButton = async () => ({ click });
    internals.findFormFrame = async () => false;

    await driver.addEntries([{ section: "Earlier Education", count: 2 }]);
    expect(click).toHaveBeenCalledTimes(2);
    // Planned again (twice, once worded differently): no more clicks on this page.
    await driver.addEntries([{ section: "Earlier Education", count: 2 }]);
    await driver.addEntries([{ section: "earlier  education", count: 2 }]);
    expect(click).toHaveBeenCalledTimes(2);
    // Another section, or the same one on another page, still gets its clicks.
    await driver.addEntries([{ section: "Past Job", count: 1 }]);
    url = "https://larsentoubrocareers.peoplestrong.com/profile/experience";
    await driver.addEntries([{ section: "Earlier Education", count: 1 }]);
    expect(click).toHaveBeenCalledTimes(4);
  });
});
