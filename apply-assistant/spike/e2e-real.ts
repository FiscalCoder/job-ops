/**
 * End-to-end dry run of M1+M2 on your real Job Ops data, with this PC playing the extension.
 *
 *   Job Ops (real, READ-ONLY here) → local apply-assistant (in-memory DB) → lookups done from
 *   this PC (find board → match → fetch form) → fill plan per matched job.
 *
 * Default: nothing is written to Job Ops; the link/note write-backs are replaced by a log line.
 * --live: talks to the deployed apply-assistant instead (APPLY_URL, default
 *   https://apply.hueint.com), so results are stored on the server and Greenhouse links + notes
 *   ARE written back to your Job Ops jobs. Lookups still run from this PC, never the server.
 * Credentials come from the repo's .env (username / password).
 *
 *   npx tsx apply-assistant/spike/e2e-real.ts [--live]   (from the repo root, after loading .env)
 */
import type { AddressInfo } from "node:net";
import { createApp } from "../server/src/http/app.js";
import { type JobOpsApi, JobOpsClient } from "../server/src/jobops/client.js";
import { openStore } from "../server/src/store/db.js";

const JOBOPS = process.env.JOBOPS_URL ?? "https://job-ops.hueint.com";
const GH = "https://boards-api.greenhouse.io/v1/boards";
const PAUSE_MS = 400;

const real = new JobOpsClient(JOBOPS);
const writes: string[] = [];
const readOnly: JobOpsApi = {
  login: (u, p) => real.login(u, p),
  me: (t) => real.me(t),
  listJobs: (t, s) => real.listJobs(t, s),
  getJob: (t, id) => real.getJob(t, id),
  getPdf: (t, id) => real.getPdf(t, id),
  getDesignResume: (t) => real.getDesignResume(t),
  updateJob: async (_t, id, update) => {
    writes.push(
      `would PATCH ${id.slice(0, 8)} ${Object.keys(update).join(",")}`,
    );
  },
  addNote: async (_t, id, note) => {
    writes.push(`would add note to ${id.slice(0, 8)}: ${note.title}`);
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ghGet = async (path: string) => {
  await sleep(PAUSE_MS);
  const res = await fetch(`${GH}${path}`, {
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
};

/** What the extension's find-board does first: guess the board token from the company name. */
const slugGuesses = (employer: string) => {
  const words = employer
    .toLowerCase()
    .replace(
      /\b(inc|llc|ltd|limited|gmbh|pvt|private|corp|corporation|technologies|technology|labs?)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set([words.join(""), words.join("-"), words[0] ?? ""])].filter(
    Boolean,
  );
};

const LIVE = process.argv.includes("--live");

async function startLocal() {
  const server = createApp({
    jobOps: readOnly,
    db: openStore(":memory:"),
    authCacheSeconds: 300,
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

const target = LIVE
  ? {
      base: process.env.APPLY_URL ?? "https://apply.hueint.com",
      close: () => {},
    }
  : await startLocal();
const base = target.base;
console.log(
  LIVE
    ? `LIVE run against ${base}: results are saved and written back to Job Ops`
    : "Read-only run (local, in-memory)",
);

const login = (await (
  await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: process.env.username,
      password: process.env.password,
    }),
  })
).json()) as { data: { token: string } };
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${login.data.token}`,
};
const api = async (path: string, body?: unknown) =>
  (await (
    await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json()) as { ok: boolean; data: any; error?: { message: string } };

type Task = { jobId: string; employer: string; title: string; task: any };

async function runTask({ jobId, employer, task }: Task): Promise<string> {
  if (task.type === "find-board" || task.type === "list-board") {
    const tokens =
      task.type === "list-board" ? [task.token] : slugGuesses(employer);
    for (const token of tokens) {
      const list = await ghGet(`/${token}/jobs`);
      const jobs = (list?.jobs as any[] | undefined) ?? null;
      if (!jobs) continue;
      const boardJobs = jobs.map((j) => ({
        id: String(j.id),
        title: j.title,
        location: j.location?.name ?? "",
        url: j.absolute_url,
      }));
      const result = {
        type: "board",
        jobId,
        employer,
        token,
        method: "name-slug",
        jobs: boardJobs,
      };
      let out = await api("/lookups/results", result);
      if (out.data?.status === "need-details") {
        const details: Record<string, string> = {};
        for (const id of out.data.postingIds.slice(0, 8)) {
          const d = await ghGet(`/${token}/jobs/${id}`);
          if (d) details[id] = String(d.content ?? "").slice(0, 150_000);
        }
        out = await api("/lookups/results", { ...result, details });
      }
      const where = out.data?.postingUrl
        ? ` ${out.data.postingUrl} (title ${out.data.titleScore?.toFixed(2)}, desc ${out.data.descScore?.toFixed(2) ?? "-"})`
        : "";
      return `board ${token}: ${out.data?.status ?? out.error?.message}${where}`;
    }
    await api("/lookups/results", {
      type: "board",
      jobId,
      employer,
      token: null,
      method: "name-slug",
    });
    return "no Greenhouse board found";
  }
  if (task.type === "verify-job") {
    const d = await ghGet(`/${task.token}/jobs/${task.postingId}`);
    const out = await api("/lookups/results", {
      type: "job",
      jobId,
      token: task.token,
      postingId: task.postingId,
      url:
        (d?.absolute_url as string) ??
        `https://job-boards.greenhouse.io/${task.token}/jobs/${task.postingId}`,
      live: d !== null,
    });
    return `posting ${out.data?.status}`;
  }
  if (task.type === "fetch-schema") {
    const payload = await ghGet(
      `/${task.token}/jobs/${task.postingId}?questions=true`,
    );
    if (!payload) return "form not reachable";
    const out = await api("/lookups/results", {
      type: "schema",
      jobId,
      token: task.token,
      postingId: task.postingId,
      payload,
    });
    return out.ok
      ? `planned: ${JSON.stringify(out.data.summary)}`
      : `schema rejected: ${out.error?.message}`;
  }
  return `skipped ${task.type} (needs the browser extension)`;
}

for (let round = 1; round <= 3; round++) {
  const pending = (await api("/lookups/pending")).data as Task[];
  if (pending.length === 0) break;
  console.log(`\nround ${round}: ${pending.length} lookups`);
  for (const t of pending)
    console.log(
      `  ${t.employer.slice(0, 28).padEnd(28)} ${t.task.type.padEnd(13)} → ${await runTask(t)}`,
    );
}

const queue = (await api("/queue")).data as any[];
for (const q of queue.filter((x) => x.plan)) {
  const plan = (await api(`/plans/${q.jobId}`)).data;
  console.log(`
plan for ${q.employer} (${q.title}), job country ${plan.jobCountry}:`);
  for (const e of plan.entries.filter((x: any) => x.status !== "skip"))
    console.log(
      `  ${e.status.padEnd(9)} ${e.actionClass.padEnd(9)} ${e.label.slice(0, 60).padEnd(60)} ${e.status === "fill" ? e.source : e.reason}`,
    );
}
console.log(
  "\nqueue (Ready jobs):",
  queue.map((q) => ({
    employer: q.employer,
    target: q.target.status,
    plan: q.plan?.summary ?? null,
  })),
);
if (!LIVE) {
  console.log(
    `\nJob Ops write-backs skipped (read-only run): ${writes.length}`,
  );
  for (const w of writes) console.log(`  ${w}`);
}
target.close();
