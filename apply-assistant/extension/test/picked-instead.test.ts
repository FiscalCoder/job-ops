import { describe, expect, it } from "vitest";
import { pickedInstead, type RescueTarget } from "../src/fill/site-help";

/** A field that shows `shown`. */
const showing = (shown: string) =>
  ({ readBack: async () => shown }) as unknown as RescueTarget;

describe("pickedInstead", () => {
  it("takes the choice Claude's steps picked by name when the field shows it", async () => {
    const steps = [
      { action: "click", value: "#source" },
      { action: "type", value: "Social" },
      { action: "pick", value: "Website/Social Media" },
    ] as const;
    expect(await pickedInstead(showing("Website/Social Media"), steps)).toBe("Website/Social Media");
  });

  it("is no pick when the steps typed that same text: a text box shows it either way (Mastercard's skills)", async () => {
    const steps = [
      { action: "click", value: "input[id='skillObject.skills']" },
      { action: "type", value: "Bash" },
      { action: "wait", value: "800" },
      { action: "pick", value: "Bash" },
    ] as const;
    expect(await pickedInstead(showing("Bash"), steps)).toBeNull();
  });
});
