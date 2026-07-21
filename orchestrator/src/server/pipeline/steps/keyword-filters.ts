import { normalizeStringArray } from "@shared/normalize-string-array.js";

/**
 * Parses a JSON-encoded string array setting value (e.g. `blockedTitleKeywords`,
 * `rejectionPhrases`, `blockedCompanyKeywords`) into a normalized string array.
 * Mirrors `parseBlockedCompanyKeywords` in discover-jobs.ts so all keyword/phrase
 * list settings share the same parsing behavior.
 */
export function parseKeywordListSetting(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeStringArray(
      parsed.filter((value): value is string => typeof value === "string"),
    );
  } catch {
    return [];
  }
}

/**
 * Case-insensitive substring match: returns the first keyword/phrase from
 * `keywords` that appears within `text`, or `null` if none match.
 */
export function findMatchingKeyword(
  text: string | null | undefined,
  keywords: string[],
): string | null {
  if (!text) return null;
  if (keywords.length === 0) return null;
  const normalizedText = text.toLowerCase();
  return (
    keywords.find((keyword) =>
      normalizedText.includes(keyword.toLowerCase()),
    ) ?? null
  );
}
