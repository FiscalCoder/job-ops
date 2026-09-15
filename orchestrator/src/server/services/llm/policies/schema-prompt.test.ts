import { describe, expect, it } from "vitest";
import type { JsonSchemaDefinition, LlmMessage } from "../types";
import { withSchemaInstruction } from "./schema-prompt";

const SCHEMA: JsonSchemaDefinition = {
  name: "job_chat_response",
  schema: {
    type: "object",
    properties: { response: { type: "string" } },
    required: ["response"],
    additionalProperties: false,
  },
};

const MESSAGES: LlmMessage[] = [
  { role: "system", content: "You are Ghostwriter." },
  { role: "user", content: "Write a cover letter." },
];

describe("withSchemaInstruction", () => {
  it("returns the original messages untouched in json_schema mode", () => {
    expect(withSchemaInstruction("json_schema", MESSAGES, SCHEMA)).toBe(
      MESSAGES,
    );
  });

  it.each(["json_object", "text", "none"] as const)(
    "appends a trailing system schema instruction in %s mode",
    (mode) => {
      const result = withSchemaInstruction(mode, MESSAGES, SCHEMA);

      expect(result).toHaveLength(MESSAGES.length + 1);
      expect(result.slice(0, MESSAGES.length)).toEqual(MESSAGES);

      const instruction = result.at(-1);
      expect(instruction?.role).toBe("system");
      expect(instruction?.content).toContain("JSON");
      expect(instruction?.content).toContain('"required":["response"]');
      expect(instruction?.content).toContain("job_chat_response");
    },
  );

  it("does not mutate the input messages array", () => {
    const input = [...MESSAGES];
    withSchemaInstruction("json_object", input, SCHEMA);
    expect(input).toEqual(MESSAGES);
  });
});
