import { describe, expect, it } from "vitest";
import type { FormSchema } from "../src/plan/form-schema.js";
import { parseLeverSchema } from "../src/plan/lever-schema.js";
import { parseFormSchema } from "../src/plan/schemas.js";
import perforce from "./fixtures/lever-eeo.json" with { type: "json" };
import matillion from "./fixtures/lever-matillion.json" with { type: "json" };
import valiantys from "./fixtures/lever-valiantys.json" with { type: "json" };

const byRef = (schema: FormSchema, ref: string) => {
  const found = schema.fields.find((f) => f.ref === ref);
  if (!found) throw new Error(`no field ${ref}`);
  return found;
};

describe("parseLeverSchema (real Valiantys, Perforce and Matillion forms)", () => {
  const schema = parseLeverSchema(valiantys);

  it("reads the posting and the standard fields with their shared names", () => {
    expect(schema).toMatchObject({
      postingId: "38eed682-f5e3-4369-b871-cc1efcb36135",
      title: "Atlassian Consultant - Cloud Practice",
      education: null,
    });
    expect(byRef(schema, "resume")).toMatchObject({
      canonical: "resume",
      type: "file",
      required: true,
    });
    expect(byRef(schema, "name")).toMatchObject({
      canonical: "full_name",
      label: "Full name",
      required: true,
    });
    expect(byRef(schema, "location")).toMatchObject({
      canonical: "location",
      section: "location",
      required: true,
    });
    expect(byRef(schema, "org")).toMatchObject({
      canonical: "current_company",
      required: false,
    });
    expect(byRef(schema, "urls[LinkedIn]")).toMatchObject({
      canonical: "linkedin",
      label: "LinkedIn URL",
    });
    expect(schema.fields.map((f) => f.ref)).not.toContain("selectedLocation");
    expect(schema.fields.map((f) => f.ref)).not.toContain("h-captcha-response");
  });

  it("reads custom questions from their card definitions", () => {
    expect(
      byRef(schema, "cards[ab4e2589-8c61-4939-8304-af50a86f59b4][field0]"),
    ).toMatchObject({
      label: "Where are you based ?",
      type: "select",
      required: true,
      options: expect.arrayContaining([{ label: "France", value: "France" }]),
    });
    expect(
      byRef(schema, "cards[0ceb64c2-7699-4fa3-a67e-1bc695db4f85][field1]"),
    ).toMatchObject({ type: "textarea", required: false });
  });

  it("reads EEO dropdowns and radio groups, and dropdown questions (Perforce)", () => {
    const eeo = parseLeverSchema(perforce);
    expect(byRef(eeo, "eeo[gender]")).toMatchObject({
      canonical: "gender",
      type: "select",
      section: "demographic",
      options: expect.arrayContaining([
        {
          label: "Decline to self-identify",
          value: "Decline to self-identify",
        },
      ]),
    });
    expect(byRef(eeo, "eeo[race]")).toMatchObject({
      canonical: "race",
      type: "select",
    });
    expect(
      eeo.fields.some((f) => f.type === "select" && f.ref.startsWith("cards[")),
    ).toBe(true);
  });

  it("skips deleted cards (Matillion)", () => {
    const m = parseLeverSchema(matillion);
    expect(
      m.fields.filter((f) =>
        f.ref.includes("6307c50b-e18e-48d4-8150-c1e5df3ed861"),
      ),
    ).toEqual([]);
    expect(
      m.fields.find((f) => f.label.startsWith("Are you willing and able")),
    ).toMatchObject({
      type: "select",
      options: [
        { label: "Yes", value: "Yes" },
        { label: "No", value: "No" },
      ],
    });
  });

  it("has a stable hash, dispatches, and rejects other payloads", () => {
    expect(parseLeverSchema(structuredClone(valiantys)).hash).toBe(schema.hash);
    expect(parseFormSchema("lever", valiantys).postingId).toBe(
      schema.postingId,
    );
    expect(() => parseLeverSchema({ id: "x" })).toThrow(/Lever/);
    expect(() =>
      parseLeverSchema({ ...valiantys, formHtml: "<p>no form</p>" }),
    ).toThrow(/Lever/);
  });
});
