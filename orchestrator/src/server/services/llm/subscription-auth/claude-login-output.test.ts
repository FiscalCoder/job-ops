import { describe, expect, it } from "vitest";
import {
  extractClaudeOauthToken,
  extractCliErrorMessage,
  extractSignInUrl,
  extractTokenLifetimeMs,
  hasCodePrompt,
  hasCodeRejection,
  stripTerminalSequences,
} from "./claude-login-output";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=Zx8_abcDEF-123&code_challenge_method=S256&state=st4te_XYZ";

const TOKEN = `sk-ant-oat01-${"AbC_dEf-123".repeat(9)}`;

function osc8(url: string, text: string): string {
  return `${ESC}]8;id=link1;${url}${ST}${text}${ESC}]8;;${ST}`;
}

/** Shaped like the pty capture from the 2026-11-27 spike. */
const LOGIN_CAPTURE = [
  `${ESC}[?25l${ESC}[2K${ESC}[1G✻ Opening browser to sign in…`,
  `\r${ESC}[2K${ESC}[1G✽ Opening browser to sign in…`,
  `\r${ESC}[2K${ESC}[1G✶ Opening browser to sign in…\r\n`,
  `${ESC}[2mBrowser didn't open? Use the url below to sign in ${ESC}[22m(c to copy)\r\n\r\n`,
  // Terminal-wrapped display text, with the full URL as the OSC-8 target.
  osc8(AUTH_URL, `${AUTH_URL.slice(0, 80)}\r\n${AUTH_URL.slice(80)}`),
  "\r\n\r\n",
  `${ESC}[1mPaste code here if prompted >${ESC}[22m `,
].join("");

const TOKEN_CAPTURE = [
  "abcdefCODE#state\r\n",
  `${ESC}[32m✓${ESC}[39m Long-lived authentication token created successfully!\r\n\r\n`,
  "Your OAuth token (valid for 1 year):\r\n\r\n",
  `${ESC}[1m${TOKEN.slice(0, 70)}\r\n${TOKEN.slice(70)}${ESC}[22m\r\n\r\n`,
  "Store this token securely. You won't be able to see it again.\r\n\r\n",
  "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\r\n",
].join("");

/** CLI 2.1.332 lays out words with cursor-column moves instead of spaces. */
function columns(words: string[]): string {
  let column = 2;
  return words
    .map((word) => {
      const placed = `${ESC}[${column}G${word}`;
      column += word.length + 1;
      return placed;
    })
    .join("");
}

const SHORT_URL =
  "https://claude.ai/oauth/authorize?IvdRs7RdHwTx0GP1relVe74W29w14UMW5hr2EAO1mBIA";

/** Shaped like the 2026-11-27 capture from CLI 2.1.332 on the server. */
const CLI_2_1_332_PROMPT = [
  `${ESC}[1A${columns(["Browser", "didn't", "open?", "Use", "the", "URL", "below", "to", "sign", "in", "(c", "to", "copy)"])}\r\r\n\r\r\n`,
  `${ESC}]8;id=18rhe18;${SHORT_URL}${BEL}${SHORT_URL}${ESC}]8;;${BEL}\r\r\n\r\r\n`,
  `${columns(["Paste", "code", "here", "if", "prompted"])}\r\r\n`,
].join("");

const CLI_2_1_332_REJECTION = [
  `${columns(["✻", "Finishing", "sign-i", "…"])}\r\r\n`,
  `${columns(["✘", "OAuth", "error:", "That", "code", "wasn't", "accepted.", "It", "may", "be", "incomplete,", "expired,", "already", "used,", "or", "from", "an", "earlier", "sign-in", "attempt.", "Sign", "in", "again", "to", "get", "a", "new", "code."])}\r\r\n`,
  `${columns(["Press", "Enter", "to", "retry"])}\r\r\n`,
].join("");

describe("CLI 2.1.332 column-positioned output", () => {
  it("keeps word gaps that the CLI draws with cursor moves", () => {
    expect(stripTerminalSequences(columns(["Paste", "code", "here"]))).toBe(
      " Paste code here",
    );
  });

  it("detects the paste prompt", () => {
    expect(hasCodePrompt(CLI_2_1_332_PROMPT)).toBe(true);
  });

  it("returns the short sign-in link", () => {
    expect(extractSignInUrl(CLI_2_1_332_PROMPT)).toBe(SHORT_URL);
  });

  it("flags the rejection", () => {
    expect(hasCodeRejection(CLI_2_1_332_REJECTION)).toBe(true);
  });

  it("extracts the CLI's own error sentence", () => {
    expect(extractCliErrorMessage(CLI_2_1_332_REJECTION)).toBe(
      "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.",
    );
  });

  it("reads a column-positioned lifetime", () => {
    expect(
      extractTokenLifetimeMs(
        columns(["Your", "OAuth", "token", "(valid", "for", "1", "year):"]),
      ),
    ).toBe(365 * 86_400_000);
  });

  it("still finds a token printed after a column move", () => {
    expect(extractClaudeOauthToken(`${ESC}[2G${TOKEN}\r\r\n`)).toBe(TOKEN);
  });
});

describe("extractCliErrorMessage", () => {
  it("returns null without an error line", () => {
    expect(extractCliErrorMessage(TOKEN_CAPTURE)).toBeNull();
  });

  it("never echoes token- or code-like runs", () => {
    expect(
      extractCliErrorMessage(`✘ OAuth error: bad ${TOKEN} value\r\n`),
    ).toBe("bad [redacted] value");
  });
});

describe("stripTerminalSequences", () => {
  it("removes CSI, OSC and charset sequences and normalises line breaks", () => {
    const raw = `${ESC}[1mBold${ESC}[0m ${ESC}]0;title${BEL}${ESC}(Bplain\r\nnext\rover`;
    expect(stripTerminalSequences(raw)).toBe("Bold plain\nnext\nover");
  });

  it("drops OSC-8 wrappers but keeps the link text", () => {
    expect(stripTerminalSequences(osc8("https://x.test", "label"))).toBe(
      "label",
    );
  });
});

describe("extractSignInUrl", () => {
  it("prefers the OSC-8 link target", () => {
    expect(extractSignInUrl(LOGIN_CAPTURE)).toBe(AUTH_URL);
  });

  it("joins a terminal-wrapped URL when no OSC-8 target exists", () => {
    const plain = `Use the url below to sign in\r\n${AUTH_URL.slice(0, 60)}\r\n${AUTH_URL.slice(60, 130)}\r\n${AUTH_URL.slice(130)}\r\n\r\nPaste code here if prompted >`;
    expect(extractSignInUrl(plain)).toBe(AUTH_URL);
  });

  it("returns null until the URL appears", () => {
    expect(extractSignInUrl(`${ESC}[2K✻ Opening browser to sign in…`)).toBe(
      null,
    );
  });

  it("ignores links to hosts that are not Anthropic sign-in pages", () => {
    const evil =
      "https://evil.example/oauth/authorize?code=true&client_id=x&redirect_uri=y";
    expect(extractSignInUrl(osc8(evil, evil))).toBe(null);
  });
});

describe("hasCodePrompt", () => {
  it("detects the paste prompt", () => {
    expect(hasCodePrompt(LOGIN_CAPTURE)).toBe(true);
    expect(hasCodePrompt("Opening browser")).toBe(false);
  });
});

describe("extractClaudeOauthToken", () => {
  it("joins a wrapped token and ignores the <token> placeholder", () => {
    expect(extractClaudeOauthToken(TOKEN_CAPTURE)).toBe(TOKEN);
  });

  it("finds a token printed on one line", () => {
    expect(extractClaudeOauthToken(`\r\n${TOKEN}\r\n`)).toBe(TOKEN);
  });

  it("does not join a following line that is a plain word", () => {
    expect(
      extractClaudeOauthToken(`${TOKEN}
Store
`),
    ).toBe(TOKEN);
    expect(
      extractClaudeOauthToken(`${TOKEN}
done
`),
    ).toBe(TOKEN);
  });

  it("refuses implausibly long token runs", () => {
    const huge = `sk-ant-oat01-${"Ab9_-".repeat(100)}`;
    expect(
      extractClaudeOauthToken(`
${huge}
`),
    ).toBe(null);
  });

  it("returns null when no token was printed", () => {
    expect(extractClaudeOauthToken(LOGIN_CAPTURE)).toBe(null);
  });
});

describe("extractTokenLifetimeMs", () => {
  it("reads 'valid for 1 year'", () => {
    expect(extractTokenLifetimeMs(TOKEN_CAPTURE)).toBe(365 * 86_400_000);
  });

  it("reads days", () => {
    expect(extractTokenLifetimeMs("(valid for 30 days)")).toBe(30 * 86_400_000);
  });

  it("returns null when the CLI states nothing", () => {
    expect(extractTokenLifetimeMs("token created")).toBe(null);
  });
});

describe("hasCodeRejection", () => {
  it.each([
    "OAuth error: invalid_grant",
    "Invalid code. Please try again.",
    "Invalid authorization code",
    "Login failed: code expired",
    "The code is invalid",
    "Authorization failed",
  ])("flags %s", (text) => {
    expect(hasCodeRejection(text)).toBe(true);
  });

  it.each([
    "error: socket hang up, retrying",
    "Error: Request failed with status code 429",
    "warning: slow network",
  ])("does not flag transient output %s", (text) => {
    expect(hasCodeRejection(text)).toBe(false);
  });

  it("does not flag the success output", () => {
    expect(hasCodeRejection(TOKEN_CAPTURE)).toBe(false);
  });
});
