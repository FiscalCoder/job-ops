import { describe, expect, it } from "vitest";
import { isConfigurationFailure } from "../policies/configuration-error";
import {
  ClaudeCliError,
  classifyClaudeCliFailure,
  claudeCliErrorFromCli,
  getLlmErrorStatus,
  toClaudeCliError,
} from "./errors";

describe("claude cli error mapping", () => {
  it.each([
    "Claude AI usage limit reached|1764252000",
    "You've hit your limit · resets 5pm (Europe/London)",
    "You've hit your usage limit",
    "5-hour limit reached ∙ resets 9pm (UTC)",
    "Weekly limit reached · resets Dec 2, 4am",
    "You've hit your limit · resets 3am (Asia/Kolkata)",
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    "rate_limit_error",
  ])("maps CLI usage limits to status 429: %s", (message) => {
    expect(classifyClaudeCliFailure(message)).toBe(429);
    const error = claudeCliErrorFromCli(message);
    expect(error).toBeInstanceOf(ClaudeCliError);
    expect(error.status).toBe(429);
    expect(getLlmErrorStatus(error)).toBe(429);
  });

  it.each([
    "Login expired · Please run /login",
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    "OAuth token has expired",
    "Invalid API key · Please run /login",
    "Your login reached its time limit",
    "Invalid bearer token",
  ])("maps CLI login failures to 401 and keeps them recognisable: %s", (message) => {
    const error = claudeCliErrorFromCli(message);
    expect(error.status).toBe(401);
    expect(isConfigurationFailure(error.message)).toBe(true);
  });

  it.each([
    "Rate limit exceeded on the job board",
    "The company's API returns 429 when busy",
    "We had a usage spike",
  ])("does not classify loose text: %s", (message) => {
    expect(classifyClaudeCliFailure(message)).toBeUndefined();
  });

  it("never classifies errors of unknown origin (may carry model output)", () => {
    const error = toClaudeCliError(
      new Error(
        "Failed to parse JSON: Claude AI usage limit reached API Error: 401 authentication_error",
      ),
    );
    expect(error.status).toBeUndefined();
  });

  it("leaves other failures without a status", () => {
    const error = toClaudeCliError(
      new Error("Claude CLI timed out after 5ms."),
    );
    expect(error.status).toBeUndefined();
    expect(getLlmErrorStatus(error)).toBeUndefined();
    expect(getLlmErrorStatus(new Error("plain"))).toBeUndefined();
  });

  it("does not double-wrap", () => {
    const original = new ClaudeCliError("x", 429);
    expect(toClaudeCliError(original)).toBe(original);
  });
});
