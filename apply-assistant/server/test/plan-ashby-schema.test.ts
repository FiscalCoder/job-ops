import { describe, expect, it } from "vitest";
import { parseAshbySchema } from "../src/plan/ashby-schema.js";
import { parseFormSchema } from "../src/plan/schemas.js";
import ciroos from "./fixtures/ashby-ciroos.json" with { type: "json" };
import elevenlabs from "./fixtures/ashby-elevenlabs.json" with { type: "json" };
import newrelic from "./fixtures/gh-newrelic.json" with { type: "json" };

const field = (schema: ReturnType<typeof parseAshbySchema>, label: string) => {
  const found = schema.fields.find((f) => f.label.startsWith(label));
  if (!found) throw new Error(`no field ${label}`);
  return found;
};

describe("parseAshbySchema (real ElevenLabs and Ciroos forms)", () => {
  it("reads the posting and maps system fields to the shared canonical names", () => {
    const schema = parseAshbySchema(elevenlabs);
    expect(schema).toMatchObject({
      postingId: "c7d59014-b918-4c15-ae33-79f5c9f2cf9f",
      title: "Full-Stack Engineer (Backend Leaning)",
      location: "United Kingdom",
      education: null,
    });
    expect(field(schema, "Name")).toMatchObject({
      ref: "_systemfield_name",
      canonical: "full_name",
      type: "text",
      required: true,
    });
    expect(field(schema, "Email")).toMatchObject({ canonical: "email" });
    expect(field(schema, "Resume")).toMatchObject({
      ref: "_systemfield_resume",
      canonical: "resume",
      type: "file",
    });
    expect(field(schema, "Location")).toMatchObject({
      canonical: "location",
      type: "text",
      section: "location",
    });
  });

  it("maps question types: choices, long text, links, numbers, phone", () => {
    const eleven = parseAshbySchema(elevenlabs);
    expect(field(eleven, "How did you hear")).toMatchObject({
      type: "select",
      options: expect.arrayContaining([
        { label: "I'm a user", value: "I'm a user" },
      ]),
    });
    expect(field(eleven, "Why ElevenLabs")).toMatchObject({
      type: "textarea",
      required: false,
    });

    const ciroosSchema = parseAshbySchema(ciroos);
    expect(field(ciroosSchema, "Mobile/Phone")).toMatchObject({
      type: "text",
      canonical: "phone",
    });
    expect(field(ciroosSchema, "Total Work Experience")).toMatchObject({
      type: "text",
    });
    expect(field(ciroosSchema, "LinkedIn")).toMatchObject({ type: "text" });
    expect(field(ciroosSchema, "Availability to Join").options).toHaveLength(3);
  });

  it("has a stable hash and rejects other payloads", () => {
    expect(parseAshbySchema(elevenlabs).hash).toBe(
      parseAshbySchema(structuredClone(elevenlabs)).hash,
    );
    expect(() => parseAshbySchema({ jobPosting: null })).toThrow(/Ashby/);
    expect(() => parseAshbySchema(newrelic)).toThrow(/Ashby/);
  });
});

describe("parseFormSchema", () => {
  it("dispatches on the application system", () => {
    expect(parseFormSchema("ashby", elevenlabs).postingId).toBe(
      "c7d59014-b918-4c15-ae33-79f5c9f2cf9f",
    );
    expect(parseFormSchema("greenhouse", newrelic).title).toBeTruthy();
    expect(() => parseFormSchema("greenhouse", elevenlabs)).toThrow();
  });
});
