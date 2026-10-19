/** Classifies a job's apply link so the resolver knows which lookup (if any) it needs. */

export type ApplyUrlKind =
  | {
      kind: "greenhouse-job";
      token: string;
      ghJobId: string;
      region: "us" | "eu";
    }
  | { kind: "greenhouse-embedded"; ghJobId: string; pageUrl: string }
  | { kind: "greenhouse-short"; url: string }
  | { kind: "board"; board: string }
  | { kind: "other" };

const GREENHOUSE_JOB_PATH = /^\/([a-z0-9_-]+)\/jobs\/(\d+)/i;
const BOARDS: readonly [RegExp, string][] = [
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)naukri\.com$/, "naukri"],
  [/(^|\.)indeed\.[a-z.]+$/, "indeed"],
  [/(^|\.)glassdoor\.[a-z.]+$/, "glassdoor"],
  [/(^|\.)wellfound\.com$/, "wellfound"],
  [/(^|\.)startup\.jobs$/, "startup.jobs"],
  [/(^|\.)arbeitnow\.[a-z.]+$/, "arbeitnow"],
  [/(^|\.)remoteok\.com$/, "remoteok"],
  [/(^|\.)remotive\.com$/, "remotive"],
];

export function classifyApplyUrl(raw: string): ApplyUrlKind {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "other" };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "grnh.se") return { kind: "greenhouse-short", url: raw };

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const match = GREENHOUSE_JOB_PATH.exec(url.pathname);
    if (match?.[1] && match[2]) {
      return {
        kind: "greenhouse-job",
        token: match[1].toLowerCase(),
        ghJobId: match[2],
        region: host.includes(".eu.") ? "eu" : "us",
      };
    }
  }

  const embeddedId = url.searchParams.get("gh_jid");
  if (embeddedId && /^\d+$/.test(embeddedId))
    return { kind: "greenhouse-embedded", ghJobId: embeddedId, pageUrl: raw };

  const board = BOARDS.find(([pattern]) => pattern.test(host));
  return board ? { kind: "board", board: board[1] } : { kind: "other" };
}
