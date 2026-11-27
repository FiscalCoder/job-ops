/**
 * Reading Hacker News hiring posts: HTML to plain text, a post's first line in parts, and
 * whether a post is someone looking for work. Ported from Dossier's src/lib/startups/text.ts
 * (github.com/AienTech/dossier, AGPL-3.0).
 */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value =
        code[1]?.toLowerCase() === "x"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000
        ? String.fromCodePoint(value)
        : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** HTML as plain text, with paragraphs kept and links written as their address. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(
        /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
        (_, href: string, label: string) => {
          const url = decodeEntities(href);
          const text = label.replace(/<[^<>]+>/g, "").trim();
          return text && decodeEntities(text) !== url ? `${text} (${url})` : url;
        },
      )
      .replace(/<\s*(p|br|li|div|h\d)[^>]*>/gi, "\n")
      .replace(/<[^<>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first web address in some text, without the punctuation of the sentence it ends. */
export function firstLink(text: string): string {
  return /https?:\/\/[^\s)<>"']*[^\s)<>"'.,;:!?]/i.exec(text)?.[0] ?? "";
}

/** A text's first non-empty line, cut at `max` characters. */
export function firstLine(text: string, max = 220): string {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.length <= max ? line.trim() : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** "Acme | Senior Android Engineer | Berlin or REMOTE (EU) | Full-time", in parts. */
export function headerParts(text: string): string[] {
  return firstLine(text, 400)
    .split(/\s+[|•·—–]\s+|\s+-\s+|\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// People looking for work sometimes post in the hiring thread, against its rules.
const FIRST_PERSON = /^(?:i(?:\s*['’]\s*m|\s+am)?\s|me\b|my name\b)/i;
const SEEKING =
  /\b(?:(?:seeking|looking for)\s+(?:work|a\s+(?:new\s+)?(?:role|job|position))|open to work|available for (?:hire|work)|hire me)\b/i;
const SEEKER_FORM = /^\s*(?:willing to relocate|r[ée]sum[ée]\s*\/\s*cv)\s*:/im;

/** Whether a post is someone looking for work rather than an employer hiring. */
export const isJobSeeker = (header: string, text: string): boolean =>
  FIRST_PERSON.test(header.trim()) || SEEKING.test(header) || SEEKER_FORM.test(text);
