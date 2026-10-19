import Fuse from "fuse.js";
import type { FieldOption } from "./gh-schema.js";

/**
 * Picks a form option for a wanted value. Same ranking that worked in the M0 spike
 * (exact > starts-with > whole word > contains), with fuse.js only for near-miss spellings.
 */

const FUZZY_THRESHOLD = 0.25;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function rank(label: string, wanted: string): number {
  if (label === wanted) return 4;
  if (label.startsWith(`${wanted} `) || label.startsWith(wanted)) return 3;
  if (new RegExp(`\\b${escapeRegExp(wanted)}\\b`).test(label)) return 2;
  if (label.includes(wanted)) return 1;
  return 0;
}

export function pickOption(
  options: readonly FieldOption[],
  wanted: string,
): FieldOption | null {
  const target = norm(wanted);
  if (!target || options.length === 0) return null;

  const ranked = options
    .map((option) => ({ option, score: rank(norm(option.label), target) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.option.label.length - b.option.label.length,
    );
  if (ranked[0]) return ranked[0].option;

  const fuse = new Fuse(options as FieldOption[], {
    keys: ["label"],
    threshold: FUZZY_THRESHOLD,
    ignoreLocation: true,
    includeScore: true,
  });
  return fuse.search(wanted.trim())[0]?.item ?? null;
}

export function pickOptions(
  options: readonly FieldOption[],
  wanted: readonly string[],
): { picked: FieldOption[]; missing: string[] } {
  const results = wanted.map((w) => ({
    wanted: w,
    option: pickOption(options, w),
  }));
  return {
    picked: results.flatMap((r) => (r.option ? [r.option] : [])),
    missing: results.filter((r) => !r.option).map((r) => r.wanted),
  };
}

const DECLINE =
  /(decline|prefer not|rather not|don'?t wish|do not wish|don'?t want|do not want|not to (answer|say|disclose))/i;

export function findDeclineOption(
  options: readonly FieldOption[],
): FieldOption | null {
  return options.find((o) => DECLINE.test(o.label.replace(/’/g, "'"))) ?? null;
}
