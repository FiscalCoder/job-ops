import { describe, expect, it, vi } from "vitest";
import { labelKey, unlearn, type SiteHelp } from "../src/fill/site-help";

const steps = [{ action: "type" as const, value: "{value}" }];

function helpWith(label: string): SiteHelp & { record: ReturnType<typeof vi.fn> } {
  return {
    act: vi.fn(),
    recipes: new Map([[labelKey(label), { labelKey: labelKey(label), steps, worked: 1, failed: 0 }]]),
    record: vi.fn().mockResolvedValue(undefined),
  };
}

describe("unlearn", () => {
  it("counts a failure for the recipe that filled a field that didn't hold", async () => {
    const help = helpWith("Skills");
    await unlearn(help, "Skills", "filled with this site's saved steps");
    expect(help.record).toHaveBeenCalledWith("Skills", steps, false);
  });

  it("counts Claude's steps too, since they were saved as the recipe", async () => {
    const help = helpWith("Skills");
    await unlearn(help, "Skills", "filled with Claude's steps (3)");
    expect(help.record).toHaveBeenCalledOnce();
  });

  it("leaves recipes alone when the field was filled without steps", async () => {
    const help = helpWith("Skills");
    await unlearn(help, "Skills", "typed");
    await unlearn(help, "Skills", undefined);
    await unlearn(null, "Skills", "filled with this site's saved steps");
    expect(help.record).not.toHaveBeenCalled();
  });
});
