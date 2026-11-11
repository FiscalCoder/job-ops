import { describe, expect, it } from "vitest";
import { takeoverSkipped } from "../src/fill/takeover-policy";

describe("where Claude's takeover isn't sent", () => {
  it("skips location fields (14% finished in the traces)", () => {
    for (const label of ["City", "State", "Country", "Address Line 1", "PIN code", "Zip Code", "Current Location", "City or Town"])
      expect(takeoverSkipped(label, "Shows \"nothing\" instead")).toMatch(/location/);
  });

  it("still takes over a phone number's country code and other fields", () => {
    for (const label of ["Country code", "Phone country", "Mobile Number Country", "Degree", "Notice period", "How did you hear about us?"])
      expect(takeoverSkipped(label, "No choice matching")).toBeNull();
  });

  it("skips a field that isn't on the page", () => {
    expect(takeoverSkipped("Degree", "Field not found on the page; fill it yourself")).toMatch(/isn't on the page/);
  });
});
