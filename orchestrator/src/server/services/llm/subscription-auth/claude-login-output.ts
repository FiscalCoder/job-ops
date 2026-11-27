/**
 * Parsers for the terminal output of `claude setup-token` run under a pty.
 * The CLI prints spinner frames, CSI colour/cursor codes and OSC-8 hyperlinks,
 * and long values (sign-in URL, token) may be wrapped across lines, so every
 * helper works on raw output and tolerates all of that.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape bytes is the point
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const OSC8_TARGET =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape bytes is the point
  /\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape bytes is the point
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape bytes is the point
const CHARSET_SEQUENCE = /\u001b[()*+][0-9A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape bytes is the point
const SHORT_ESCAPE = /\u001b[@-Z\\-_=>78]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape bytes is the point
const OTHER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const URL_CHAR = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
const TOKEN_CHAR = "A-Za-z0-9_\\-";
const TOKEN_PREFIX = "sk-ant-oat";
const TOKEN_SHAPE = /^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/;
const MAX_TOKEN_CHARS = 400;
/** A lone word ("Store", "done") is CLI prose, never a wrapped value. */
const PLAIN_WORD_LINE = /^[A-Za-z][a-z]*$/;
const CODE_REJECTION_PATTERN =
  /invalid (authorization )?code|code (is )?(invalid|expired)|OAuth error|authorization failed/i;

const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "anthropic.com"];
const DAY_MS = 86_400_000;
const LIFETIME_UNIT_MS: Record<string, number> = {
  hour: 3_600_000,
  day: DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

export function stripTerminalSequences(raw: string): string {
  return raw
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(CHARSET_SEQUENCE, "")
    .replace(SHORT_ESCAPE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(OTHER_CONTROL, "");
}

/**
 * Read a value starting at `start` that the terminal may have wrapped onto
 * following lines: continuation lines are joined while they consist solely of
 * value characters. A blank line, a plain word or any other text ends it.
 */
function readWrappedRun(
  text: string,
  start: number,
  charClass: string,
): string {
  const runPattern = new RegExp(`^[${charClass}]+`);
  const fullLinePattern = new RegExp(`^[${charClass}]+$`);
  const lines = text.slice(start).split("\n");
  const firstLine = lines[0] ?? "";
  const firstRun = firstLine.match(runPattern)?.[0] ?? "";
  if (firstRun.length !== firstLine.trimEnd().length) return firstRun;

  const continuation: string[] = [];
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || !fullLinePattern.test(trimmed)) break;
    if (PLAIN_WORD_LINE.test(trimmed)) break;
    continuation.push(trimmed);
  }
  return [firstRun, ...continuation].join("");
}

function findAll(text: string, needle: string): number[] {
  const indexes: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    indexes.push(index);
    index = text.indexOf(needle, index + needle.length);
  }
  return indexes;
}

function isAllowedSignInUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      SIGN_IN_HOSTS.some(
        (allowed) => host === allowed || host.endsWith(`.${allowed}`),
      ) &&
      url.pathname.includes("/oauth/authorize")
    );
  } catch {
    return false;
  }
}

/** The Anthropic sign-in URL, preferring the untruncated OSC-8 link target. */
export function extractSignInUrl(raw: string): string | null {
  for (const match of raw.matchAll(OSC8_TARGET)) {
    const target = match[1]?.trim();
    if (target && isAllowedSignInUrl(target)) return target;
  }
  const text = stripTerminalSequences(raw);
  for (const index of findAll(text, "https://")) {
    const candidate = readWrappedRun(text, index, URL_CHAR);
    if (isAllowedSignInUrl(candidate)) return candidate;
  }
  return null;
}

export function hasCodePrompt(raw: string): boolean {
  return /paste code here/i.test(stripTerminalSequences(raw));
}

/** The long-lived OAuth token printed after a successful code exchange. */
export function extractClaudeOauthToken(raw: string): string | null {
  const text = stripTerminalSequences(raw);
  const candidates = findAll(text, TOKEN_PREFIX)
    .map((index) => readWrappedRun(text, index, TOKEN_CHAR))
    .filter(
      (candidate) =>
        candidate.length <= MAX_TOKEN_CHARS && TOKEN_SHAPE.test(candidate),
    );
  if (candidates.length === 0) return null;
  return candidates.reduce((longest, candidate) =>
    candidate.length > longest.length ? candidate : longest,
  );
}

/** Token lifetime when the CLI states one ("valid for 1 year"). */
export function extractTokenLifetimeMs(raw: string): number | null {
  const match = stripTerminalSequences(raw).match(
    /valid for (\d+|one|a|an) (hour|day|month|year)s?/i,
  );
  if (!match) return null;
  const amountText = match[1]?.toLowerCase() ?? "";
  const amount = /^\d+$/.test(amountText) ? Number.parseInt(amountText, 10) : 1;
  const unitMs = LIFETIME_UNIT_MS[match[2]?.toLowerCase() ?? ""];
  if (!unitMs || !Number.isFinite(amount) || amount <= 0) return null;
  return amount * unitMs;
}

/**
 * Output after a submitted code that may mean Anthropic refused it. Only
 * narrow, known phrases count; the caller still waits a short grace window
 * for a token before treating this as a rejection.
 */
export function hasCodeRejection(raw: string): boolean {
  return CODE_REJECTION_PATTERN.test(stripTerminalSequences(raw));
}
