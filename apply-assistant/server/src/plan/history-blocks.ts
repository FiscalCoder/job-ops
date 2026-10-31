import type { ResumeFacts } from "./resume-facts.js";
import type { WorkdayPage } from "./workday-schema.js";

/**
 * Work history and education on a company's own page (iCIMS: one fieldset per job, often
 * already filled from the resume you uploaded). Each block is matched to a job or degree on your
 * Job Ops resume by what it already shows, so the employer, title, dates and the employer's
 * address in a block all come from that one job, never from your own address or a
 * question-by-question guess. Blocks with no job left are left alone.
 */

type PageField = WorkdayPage["fields"][number];
type Section = "experience" | "education";

/** A block's index when no job or degree is left for it: resolves to nothing. */
const UNMATCHED = 999;

const SECTION_OF: readonly [RegExp, Section][] = [
  [
    /experience|employment|work history|career history|employer|positions? held/i,
    "experience",
  ],
  [/education|academic|qualification|school|degree/i, "education"],
];

/** "Start Date Month" → "startMonth"; "From" → "startDate". */
function dateRole(label: string, start: string, end: string): string | null {
  const part = /month/i.test(label)
    ? "Month"
    : /\bday\b/i.test(label)
      ? "Day"
      : /year/i.test(label)
        ? "Year"
        : "Date";
  if (/\b(start|from|began|begin)/i.test(label)) return `${start}${part}`;
  if (/\b(end|to|until|finish|left)\b/i.test(label)) return `${end}${part}`;
  return null;
}

/** What a field in a work-history block asks, by its label. */
function experiencePart(label: string): string {
  if (/current(ly)?|present|still work/i.test(label)) return "currentlyWorkHere";
  const date = dateRole(label, "start", "end");
  if (date && /date|month|year|\bday\b|from|\bto\b/i.test(label)) return date;
  if (/address|street/i.test(label)) return "employerAddress";
  if (/\bcity\b|town/i.test(label)) return "employerCity";
  if (/zip|postal|pin ?code/i.test(label)) return "employerZip";
  if (/\bstate\b|province|region/i.test(label)) return "employerState";
  if (/country/i.test(label)) return "employerCountry";
  if (/employer|company|organi[sz]ation/i.test(label)) return "companyName";
  if (/title|position|designation|\brole\b/i.test(label)) return "jobTitle";
  if (/description|responsibilit|duties|summary|achievement/i.test(label))
    return "roleDescription";
  return "other";
}

/** What a field in an education block asks, by its label. */
function educationPart(label: string): string {
  if (/other/i.test(label)) return "other";
  if (/school|institut|universit|college/i.test(label)) return "school";
  if (/major|field of study|discipline|speciali[sz]|subject/i.test(label))
    return "fieldOfStudy";
  if (/degree|qualification/i.test(label)) return "degree";
  if (/graduat/i.test(label)) return "graduated";
  const date = dateRole(label, "firstYear", "lastYear");
  return date?.endsWith("Year") ? date : "other";
}

interface Block {
  readonly id: string;
  readonly heading: string;
  readonly section: Section;
  readonly fields: readonly { readonly field: PageField; readonly part: string }[];
}

/** The page's work-history and education blocks, in page order. */
function blocksOf(fields: readonly PageField[]): Block[] {
  const grouped = new Map<string, PageField[]>();
  for (const field of fields)
    if (field.block)
      grouped.set(field.block.id, [
        ...(grouped.get(field.block.id) ?? []),
        field,
      ]);
  return [...grouped.entries()].flatMap(([id, members]) => {
    const heading = members[0]?.block?.heading ?? "";
    const section = SECTION_OF.find(([pattern]) => pattern.test(heading))?.[1];
    if (!section) return [];
    const partOf = section === "experience" ? experiencePart : educationPart;
    const parts = members.map((field) => ({
      field,
      part: partOf(field.label),
    }));
    // A real entry names its employer or school.
    const anchor = section === "experience" ? "companyName" : "school";
    return parts.some((p) => p.part === anchor)
      ? [{ id, heading, section, fields: parts }]
      : [];
  });
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The same organisation, give or take a suffix ("Tarento" / "Tarento Group"). */
export function sameName(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  return (
    x.length > 1 &&
    y.length > 1 &&
    (x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `))
  );
}

const shown = (block: Block, part: string) =>
  block.fields.find((f) => f.part === part)?.field.value?.trim() ?? "";

/**
 * A pick the site already made from its own searched list ("Bcom", "India"): kept, since our
 * wording ("Bachelor's Degree") could only find something worse. Lists it shows (month
 * dropdowns) and text are filled from your resume.
 */
const keptPick = (field: PageField) =>
  (field.kind === "dropdown" || field.kind === "search") &&
  field.options.length === 0 &&
  (field.value ?? "").trim() !== "";

/**
 * Which resume entry each block is: the closest pairs first (how much of the entry the block
 * already shows), then the rest in page order take the entries left, in resume order.
 */
function assign(
  blocks: readonly Block[],
  count: number,
  score: (block: number, entry: number) => number,
): Map<string, number> {
  const taken = new Set<number>();
  const result = new Map<string, number>();
  const pairs = blocks
    .flatMap((_, b) =>
      [...Array(count).keys()].map((e) => ({ b, e, s: score(b, e) })),
    )
    .filter((p) => p.s > 0)
    .sort((x, y) => y.s - x.s || x.b - y.b || x.e - y.e);
  for (const { b, e } of pairs) {
    const block = blocks[b];
    if (!block || result.has(block.id) || taken.has(e)) continue;
    taken.add(e);
    result.set(block.id, e);
  }
  for (const block of blocks) {
    if (result.has(block.id)) continue;
    const next = [...Array(count).keys()].find((i) => !taken.has(i));
    if (next === undefined) {
      result.set(block.id, UNMATCHED);
      continue;
    }
    taken.add(next);
    result.set(block.id, next);
  }
  return result;
}

/**
 * "history.experience.<n>.<part>" (or education) for every field in a recognised block, n being
 * the matching entry on your resume. Fields outside blocks aren't in the map.
 */
export function historyCanonicals(
  fields: readonly PageField[],
  resume: ResumeFacts,
): Map<string, string> {
  const blocks = blocksOf(fields);
  const names = new Map<string, string>();
  for (const section of ["experience", "education"] as const) {
    const mine = blocks.filter((b) => b.section === section);
    const order =
      section === "experience"
        ? assign(mine, resume.experience.length, (b, e) => {
            const block = mine[b] as Block;
            const job = resume.experience[e];
            if (!job) return 0;
            const title = words(shown(block, "jobTitle"));
            const year = shown(block, "startYear");
            return (
              (sameName(shown(block, "companyName"), job.company) ? 2 : 0) +
              // Titles exactly: "Engineer" isn't "Senior Engineer".
              (title && title === words(job.title) ? 1 : 0) +
              (year && year === String(job.start?.year ?? "") ? 1 : 0)
            );
          })
        : assign(mine, resume.education.length, (b, e) => {
            const degree = resume.education[e];
            return degree &&
              sameName(shown(mine[b] as Block, "school"), degree.school)
              ? 1
              : 0;
          });
    for (const block of mine)
      for (const { field, part } of block.fields)
        names.set(
          field.ref,
          `history.${section}.${order.get(block.id) ?? UNMATCHED}.${
            keptPick(field) ? "kept" : part
          }`,
        );
  }
  return names;
}

/** The most blocks of one kind added for you on one page. */
const MAX_ADD = 6;

/**
 * Fewer blocks on the page than jobs (or degrees) on your resume: how many more to add with
 * the site's own "Add More (Professional Experience)", by the section's name. A section the
 * page doesn't have at all isn't added.
 */
export function blocksToAdd(
  fields: readonly PageField[],
  resume: ResumeFacts,
): { section: string; count: number }[] {
  const blocks = blocksOf(fields);
  return (["experience", "education"] as const).flatMap((section) => {
    const mine = blocks.filter((b) => b.section === section);
    const first = mine[0];
    const wanted =
      section === "experience"
        ? resume.experience.length
        : resume.education.length;
    if (!first || wanted <= mine.length) return [];
    return [
      {
        // "Professional Experience (1)" → "Professional Experience"
        section: first.heading.replace(/\s*\(\d+\)\s*$/, "").trim(),
        count: Math.min(wanted - mine.length, MAX_ADD),
      },
    ];
  });
}
