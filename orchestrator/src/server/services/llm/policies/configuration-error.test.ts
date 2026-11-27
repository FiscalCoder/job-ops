import { describe, expect, it } from "vitest";
import { isConfigurationFailure } from "./configuration-error";

describe("isConfigurationFailure", () => {
  it("flags a missing API key", () => {
    expect(isConfigurationFailure("LLM API key not configured")).toBe(true);
  });

  it("flags rejected credentials", () => {
    expect(isConfigurationFailure("LLM API error: 401 - Invalid API key")).toBe(
      true,
    );
    expect(isConfigurationFailure("LLM API error: 403 - Forbidden")).toBe(true);
  });

  it("flags CLI providers that are not logged in", () => {
    expect(
      isConfigurationFailure(
        "Codex is not authenticated in this container. Run `codex login` and try again.",
      ),
    ).toBe(true);
    expect(isConfigurationFailure("Gemini CLI is not logged in")).toBe(true);
  });

  it.each([
    "Claude subscription is not logged in. Connect your Claude subscription in Settings → AI provider.",
    "Login expired · Please run /login",
    "Your login reached its time limit. Please run /login",
    "Invalid API key · Please run /login",
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    "OAuth token revoked",
    "Invalid bearer token",
    "Claude login expired on 2027-11-27. Reconnect your Claude subscription in Settings → AI provider.",
  ])("flags Claude subscription login failures: %s", (message) => {
    expect(isConfigurationFailure(message)).toBe(true);
  });

  it.each([
    "API Error: 401 something",
    '{"type":"error","error":{"type":"authentication_error"}}',
    "Failed to parse JSON response: the posting says API Error: 401",
  ])("only trusts 401/authentication_error from the CLI error field: %s", (message) => {
    expect(isConfigurationFailure(message)).toBe(false);
  });

  it("does not flag Claude usage limits as configuration", () => {
    expect(
      isConfigurationFailure("Claude AI usage limit reached|1764252000"),
    ).toBe(false);
    expect(isConfigurationFailure("You've hit your limit · resets 5pm")).toBe(
      false,
    );
  });

  it("does not flag transient provider faults", () => {
    expect(isConfigurationFailure("No content in response")).toBe(false);
    expect(isConfigurationFailure("Rate limit exceeded")).toBe(false);
    expect(isConfigurationFailure("LLM API error: 429 - slow down")).toBe(
      false,
    );
    expect(isConfigurationFailure("LLM API error: 500 - internal error")).toBe(
      false,
    );
    expect(isConfigurationFailure("Request timed out")).toBe(false);
    expect(
      isConfigurationFailure("Unable to parse JSON from model response"),
    ).toBe(false);
  });

  it("does not flag a 404 or other 4xx as configuration", () => {
    expect(isConfigurationFailure("LLM API error: 404 - not found")).toBe(
      false,
    );
    expect(isConfigurationFailure("LLM API error: 400 - bad request")).toBe(
      false,
    );
  });
});
