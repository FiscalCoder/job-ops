import type { LlmMessageContent, LlmRequestOptions } from "../types";
import { getLlmMessageText } from "../types";
import { buildHeaders, joinUrl } from "../utils/http";
import { getNestedValue } from "../utils/object";
import { createProviderStrategy } from "./factory";

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Anthropic prompt caching (`cache_control: {type: "ephemeral"}`) is GA on the
 * standard Messages API (no beta header needed) but only actually caches a
 * block once its content clears a minimum token count — below that, the API
 * silently skips caching (no error; `cache_creation_input_tokens` /
 * `cache_read_input_tokens` both stay 0). That minimum varies by model, from
 * ~512 tokens (Claude Fable 5) up to ~4096 tokens (e.g. Opus 4.6/4.5, Haiku
 * 4.5), and this codebase can point the "scoring" purpose at any current
 * Anthropic model. 4000 characters (~1000 tokens at a rough ~4 chars/token
 * proxy) is a conservative middle ground: comfortably above the lowest tier's
 * floor, and — since the tolerable failure mode below the true minimum is
 * "no caching happens, no error" rather than any incorrect behavior — a
 * reasonable line under which wrapping a short system prompt just wastes the
 * ~1.25x cache-write premium for no benefit.
 */
const MIN_CACHEABLE_SYSTEM_CHARS = 4000;

/**
 * Anthropic's structured output (`output_config.format.schema`) only supports a
 * subset of JSON Schema. Validation/constraint keywords such as `maxItems`
 * cause a 400 (e.g. "For 'array' type, property 'maxItems' is not supported").
 * Schemas in this codebase are authored to work across providers (OpenAI /
 * OpenRouter accept these keywords), so strip the unsupported keywords before
 * sending to Anthropic instead of maintaining a separate schema per provider.
 */
const ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
]);

// Keys whose values are maps of (arbitrary) names to nested schemas. Their keys
// must be preserved verbatim and only their values sanitized, so a property
// legitimately named e.g. "format" or "pattern" is never dropped.
const SCHEMA_NAME_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
]);

function sanitizeAnthropicSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeAnthropicSchema);
  }
  if (!node || typeof node !== "object") {
    return node;
  }

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }

    if (
      SCHEMA_NAME_MAP_KEYS.has(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const nested: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        nested[name] = sanitizeAnthropicSchema(schema);
      }
      result[key] = nested;
      continue;
    }

    result[key] = sanitizeAnthropicSchema(value);
  }

  return result;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: AnthropicImageSource;
    };

type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

export const anthropicStrategy = createProviderStrategy({
  provider: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  requiresApiKey: true,
  modes: ["json_schema", "json_object", "none"],
  validationPaths: ["/v1/models"],
  buildRequest: ({ mode, baseUrl, apiKey, model, messages, jsonSchema }) => {
    const { system, anthropicMessages } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: anthropicMessages,
    };

    if (system) {
      body.system =
        system.length > MIN_CACHEABLE_SYSTEM_CHARS
          ? [
              {
                type: "text",
                text: system,
                cache_control: { type: "ephemeral" },
              },
            ]
          : system;
    }

    if (mode === "json_schema") {
      body.output_config = {
        format: {
          type: "json_schema",
          schema: sanitizeAnthropicSchema(jsonSchema.schema),
        },
      };
    } else if (mode === "json_object") {
      body.output_config = {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      };
    }

    return {
      url: joinUrl(baseUrl, "/v1/messages"),
      headers: buildHeaders({ apiKey, provider: "anthropic" }),
      body,
    };
  },
  extractText: (response) => {
    const content = getNestedValue(response, ["content"]);
    if (!Array.isArray(content)) return null;

    const text = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const type = getNestedValue(part, ["type"]);
        const value = getNestedValue(part, ["text"]);
        return type === "text" && typeof value === "string" ? value : "";
      })
      .join("");

    return text || null;
  },
});

function toAnthropicMessages(
  messages: LlmRequestOptions<unknown>["messages"],
): {
  system: string | null;
  anthropicMessages: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  }>;
} {
  const systemMessages: string[] = [];
  const anthropicMessages: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = getLlmMessageText(message.content).trim();
      if (text) systemMessages.push(text);
      continue;
    }

    anthropicMessages.push({
      role: message.role,
      content: toAnthropicContent(message.content),
    });
  }

  return {
    system: systemMessages.length > 0 ? systemMessages.join("\n\n") : null,
    anthropicMessages,
  };
}

function toAnthropicContent(
  content: LlmMessageContent,
): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }

    return {
      type: "image",
      source: toAnthropicImageSource(part.imageUrl, part.mediaType),
    };
  });
}

function toAnthropicImageSource(
  imageUrl: string,
  fallbackMediaType: string,
): AnthropicImageSource {
  const match = imageUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return { type: "url", url: imageUrl };
  }

  return {
    type: "base64",
    media_type: match[1] || fallbackMediaType,
    data: match[2],
  };
}
