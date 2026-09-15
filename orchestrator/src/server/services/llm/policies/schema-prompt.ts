import type {
  JsonSchemaDefinition,
  LlmMessage,
  ResponseMode,
} from "../types";

/**
 * In json_schema mode the provider API enforces the response shape itself.
 * Every other mode ("json_object", "text", "none") drops the schema entirely,
 * so callers that rely on schema enforcement alone (e.g. Ghostwriter's
 * {"response": ...} contract) get arbitrarily-shaped JSON back from providers
 * without structured-output support, such as DeepSeek. For those modes the
 * schema is restated as a trailing system instruction. The wording must
 * contain the word "JSON": some json_object implementations reject requests
 * whose messages never mention it.
 */
export function withSchemaInstruction(
  mode: ResponseMode,
  messages: LlmMessage[],
  jsonSchema: JsonSchemaDefinition,
): LlmMessage[] {
  if (mode === "json_schema") return messages;
  return [
    ...messages,
    {
      role: "system",
      content: buildSchemaInstruction(jsonSchema),
    },
  ];
}

function buildSchemaInstruction(jsonSchema: JsonSchemaDefinition): string {
  return [
    "Respond with ONLY a single JSON object that conforms exactly to this JSON Schema.",
    "Use exactly the required property names. Do not add extra keys, markdown fences, or commentary.",
    `JSON Schema (${jsonSchema.name}):`,
    JSON.stringify(jsonSchema.schema),
  ].join("\n");
}
