/**
 * Validates the resolver's matcher on REAL data: Job Ops jobs (title, location, description)
 * against their companies' live Greenhouse boards (public Job Board API, fetched from this PC).
 * Ground truth: for jobs whose link already names a Greenhouse posting, the matcher must pick
 * that exact posting out of the whole board. Read-only; nothing is written anywhere.
 *
 * Usage: npx tsx apply-assistant/spike/validate-matching.ts --data <dbdata.json> --jds <jds.json>
 */
import { readFileSync } from "node:fs";
import { getJobsFromBoard } from "../../career-boards/greenhouse/src/index";
import { classifyApplyUrl } from "../server/src/resolver/greenhouse-url";
import { type BoardJob, matchOnBoard } from "../server/src/resolver/match";
import { htmlToText } from "../server/src/resolver/text";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const data = JSON.parse(readFileSync(arg("data") ?? "", "utf8")) as {
  jobs: {
    id: string;
    title: string;
    employer: string;
    status: string;
    u: string;
    ghSlug: string | null;
  }[];
};
const jds = new Map(
  (
    JSON.parse(readFileSync(arg("jds") ?? "", "utf8")) as {
      id: string;
      location: string | null;
      d: string | null;
    }[]
  ).map((j) => [j.id, j]),
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boardFor(
  token: string,
  _region: "us" | "eu",
): Promise<BoardJob[]> {
  // One public API host serves every region; region only changes the form page URL.
  const { jobs } = await getJobsFromBoard({
    careersUrl: `https://job-boards.greenhouse.io/${token}`,
    signal: AbortSignal.timeout(20000),
  });
  return jobs.map((j) => ({
    id: j.externalId,
    title: j.title,
    location: j.locationText ?? "",
    url: j.jobUrl,
  }));
}

async function content(
  token: string,
  id: string,
  _region: "us" | "eu",
): Promise<string> {
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`,
    { signal: AbortSignal.timeout(20000) },
  ).catch(() => null);
  if (!res?.ok) return "";
  return htmlToText(((await res.json()) as { content?: string }).content ?? "");
}

const tally = {
  exact: 0,
  wrongPick: 0,
  matched: 0,
  possible: 0,
  none: 0,
  skipped: 0,
};
for (const job of data.jobs.filter((j) => j.status !== "applied")) {
  let link = classifyApplyUrl(job.u);
  if (link.kind === "greenhouse-short") {
    const res = await fetch(job.u, {
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);
    link = classifyApplyUrl(res?.url ?? job.u);
  }
  const token = link.kind === "greenhouse-job" ? link.token : job.ghSlug;
  const region = link.kind === "greenhouse-job" ? link.region : "us";
  const expectedId =
    link.kind === "greenhouse-job" || link.kind === "greenhouse-embedded"
      ? link.postingId
      : null;
  if (!token) {
    tally.skipped++;
    continue;
  }
  const jd = jds.get(job.id);
  let board: BoardJob[];
  try {
    board = await boardFor(token, region);
  } catch {
    console.log(`  ? ${job.employer}: board ${token} unavailable`);
    tally.skipped++;
    continue;
  }

  const input = {
    title: job.title,
    location: jd?.location ?? "",
    description: jd?.d ?? "",
  };
  let result = matchOnBoard(input, board, {});
  if (result.status === "need-details") {
    const details: Record<string, string> = {};
    for (const id of result.postingIds) {
      details[id] = await content(token, id, region);
      await sleep(250);
    }
    result = matchOnBoard(input, board, details);
  }
  tally[result.status === "need-details" ? "none" : result.status]++;
  const picked =
    result.status === "matched" || result.status === "possible"
      ? result.job.id
      : null;
  let verdict = "";
  if (expectedId) {
    if (picked === expectedId) {
      tally.exact++;
      verdict = "✓ exact posting";
    } else if (picked) {
      tally.wrongPick++;
      verdict = `✗ picked ${picked}, link says ${expectedId}`;
    } else
      verdict = `– not found on board (link says ${expectedId}; posting may be closed)`;
  }
  const scores =
    result.status === "matched" || result.status === "possible"
      ? `title ${result.titleScore.toFixed(2)} desc ${result.descScore?.toFixed(2) ?? "n/a"}`
      : result.status === "none"
        ? result.reason
        : "";
  console.log(
    `  ${result.status.padEnd(8)} ${job.employer.slice(0, 18).padEnd(18)} ${job.title.slice(0, 38).padEnd(38)} ${scores.padEnd(28)} ${verdict}`,
  );
  await sleep(300);
}
console.log("\n", JSON.stringify(tally));
