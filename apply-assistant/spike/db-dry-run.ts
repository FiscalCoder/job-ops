/**
 * M0 spike, pass 3: dry run with REAL Job Ops data.
 *
 *  - Jobs come from the Job Ops DB export (Greenhouse-linked jobs, or jobs whose company has a
 *    Greenhouse board); board lookup + job matching reuse upstream `career-boards/greenhouse`.
 *  - Field values come from your Job Ops profile (design resume): name, email, phone, links,
 *    education. Screening questions have no answer bank yet → reported as "needs you".
 *  - Resume: a real tailored PDF from Job Ops is attached.
 *
 * SAFETY: every non-GET request is aborted (nothing is posted, the resume is never uploaded),
 * Submit is never clicked, and personal values are masked in the printed report.
 *
 * Usage (from repo root):
 *   npx tsx apply-assistant/spike/db-dry-run.ts --data <dbdata.json> --pdf <resume.pdf> [--headed] [--only <n>]
 *   --headed  opens a visible browser, slowed down, and waits for Enter before closing each job.
 */
import { readFileSync } from "node:fs";
import readline from "node:readline/promises";
import { chromium, type Frame, type Page } from "playwright";
import { getJobsFromBoard } from "../../career-boards/greenhouse/src/index";

interface DbJob {
  id: string;
  title: string;
  employer: string;
  status: string;
  sc: number | null;
  u: string;
  ghSlug: string | null;
}
interface Profile {
  name?: string;
  email?: string;
  phone?: string;
  url?: string;
  location?: { city?: string; region?: string; countryCode?: string };
  profiles: { network?: string; url?: string }[];
  education: {
    school?: string;
    degree?: string;
    area?: string;
    period?: string;
  }[];
  experience: {
    company?: string;
    position?: string;
    location?: string;
    period?: string;
  }[];
}
type Source =
  | "profile"
  | "resume.education"
  | "resume.experience"
  | "default"
  | "tailored pdf";
interface PlanItem {
  id: string;
  kind: "text" | "select" | "file" | "repeat";
  value: string;
  search?: string;
  source: Source;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataPath = opt("data");
const pdfPath = opt("pdf");
if (!dataPath || !pdfPath) {
  console.error(
    "usage: npx tsx apply-assistant/spike/db-dry-run.ts --data <dbdata.json> --pdf <resume.pdf> [--headed] [--only n]",
  );
  process.exit(1);
}
const HEADED = flag("headed");
const ONLY = Number(opt("only") ?? "5");
const { jobs, profile } = JSON.parse(readFileSync(dataPath, "utf8")) as {
  jobs: DbJob[];
  profile: Profile;
};
const pdf = readFileSync(pdfPath);

const mask = (v: string) =>
  v.length <= 3 ? "***" : `${v.slice(0, 2)}***${v.slice(-1)}`;
const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/\bsr\.?\b/g, "senior")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
function titleScore(a: string, b: string): number {
  const A = new Set(
    norm(a)
      .split(" ")
      .filter((w) => w.length > 1),
  );
  const B = new Set(
    norm(b)
      .split(" ")
      .filter((w) => w.length > 1),
  );
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.max(A.size, B.size));
}

/** Resolver (lite): direct Greenhouse link, else best title match on the company's board. */
async function resolveGreenhouseUrl(
  job: DbJob,
): Promise<{ url: string | null; how: string }> {
  if (/greenhouse\.io/.test(job.u)) return { url: job.u, how: "direct link" };
  if (/grnh\.se/.test(job.u)) {
    const res = await fetch(job.u, { redirect: "follow" });
    return { url: res.url, how: "grnh.se redirect" };
  }
  if (!job.ghSlug) return { url: null, how: "no board" };
  const board = await getJobsFromBoard({
    careersUrl: `https://job-boards.greenhouse.io/${job.ghSlug}`,
  });
  const ranked = board.jobs
    .map((j) => ({ j, s: titleScore(job.title, j.title) }))
    .sort((a, b) => b.s - a.s);
  const best = ranked[0];
  if (!best || best.s < 0.6)
    return {
      url: null,
      how: `no title match on ${job.ghSlug} (best ${best?.s.toFixed(2) ?? "-"})`,
    };
  return {
    url: best.j.jobUrl,
    how: `board ${job.ghSlug}, title match ${best.s.toFixed(2)}`,
  };
}

const DEGREE_RULES: [RegExp, string][] = [
  [/\b(ph\.?\s?d|doctor)/i, "Doctor of Philosophy"],
  [/\bm\.?\s?b\.?\s?a\b/i, "Master of Business Administration"],
  [
    /\b(m\.?\s?tech|m\.?\s?sc|m\.?\s?s\b|mca|m\.?\s?e\b|master)/i,
    "Master's Degree",
  ],
  [
    /\b(b\.?\s?com|b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|bca|b\.?\s?a\b|bachelor)/i,
    "Bachelor's Degree",
  ],
  [/(diploma|certificate)/i, "Other"],
];
const canonicalDegree = (d = "") =>
  DEGREE_RULES.find(([re]) => re.test(d))?.[1] ?? "Other";

/** Build the fill plan from the profile + the field ids actually present on this form. */
function buildPlan(
  present: Set<string>,
  labels: Map<string, string>,
): { plan: PlanItem[]; needsYou: string[] } {
  const plan: PlanItem[] = [];
  const [first = "", ...rest] = (profile.name ?? "").trim().split(/\s+/);
  const last = rest.join(" ");
  const city =
    profile.location?.city ||
    profile.experience[0]?.location?.split(",")[0]?.trim() ||
    "";
  const linkedin = profile.profiles.find(
    (p) =>
      /linkedin/i.test(p.network ?? "") || /linkedin\.com/i.test(p.url ?? ""),
  )?.url;
  const add = (
    id: string,
    kind: PlanItem["kind"],
    value: string | undefined,
    source: Source,
    search?: string,
  ) => {
    if (present.has(id) && value)
      plan.push({ id, kind, value, source, ...(search ? { search } : {}) });
  };
  add("country", "select", "India", "default", "India"); // country before phone (M0 finding)
  add("first_name", "text", first, "profile");
  add("last_name", "text", last, "profile");
  add("preferred_name", "text", first, "profile");
  add("email", "text", profile.email, "profile");
  add("phone", "text", profile.phone?.replace(/^\+91\s*/, ""), "profile");
  if (city)
    add("candidate-location", "select", city, "resume.experience", city);
  const hasEducation = present.has("school--0");
  if (hasEducation)
    profile.education.forEach((e, i) => {
      if (i > 0 && present.has("school--0") && !present.has(`school--${i}`))
        plan.push({
          id: "school--",
          kind: "repeat",
          value: "add",
          source: "resume.education",
        });
      const deg = canonicalDegree(e.degree);
      plan.push({
        id: `school--${i}`,
        kind: "select",
        value: e.school ?? "Other",
        search: (e.school ?? "Other").split(/\s+/).slice(0, 2).join(" "),
        source: "resume.education",
      });
      plan.push({
        id: `degree--${i}`,
        kind: "select",
        value: deg,
        search: deg.split(/[ ']/)[0],
        source: "resume.education",
      });
      plan.push({
        id: `discipline--${i}`,
        kind: "select",
        value: e.area ?? "Other",
        search: (e.area ?? "Other").split(/\s+/)[0],
        source: "resume.education",
      });
    });
  for (const [id, label] of labels) {
    if (/linkedin/i.test(label) && linkedin)
      add(id, "text", linkedin, "profile");
    else if (/website|portfolio|github/i.test(label) && profile.url)
      add(id, "text", profile.url, "profile");
  }
  add("resume", "file", "resume.pdf", "tailored pdf"); // attach LAST (it uploads immediately in real use)
  const planned = new Set(plan.map((p) => p.id));
  const needsYou = [...labels]
    .filter(
      ([id, label]) =>
        label.endsWith("*") &&
        !planned.has(id) &&
        !/^(school|degree|discipline)--/.test(id),
    )
    .map(([, l]) => l.replace(/\*$/, ""));
  return { plan, needsYou };
}

async function clickField(frame: Frame, sel: string) {
  await frame.evaluate(
    (s) => document.querySelector(s)?.scrollIntoView({ block: "center" }),
    sel,
  );
  try {
    await frame.click(sel, { timeout: 4000 });
  } catch {
    await frame.click(sel, { timeout: 4000, force: true });
  }
}

async function trustedSelect(
  frame: Frame,
  id: string,
  wanted: string,
  search: string,
): Promise<{ ok: boolean; picked: string }> {
  const page = frame.page();
  await clickField(frame, `[id="${id}"]`);
  await page.keyboard.type(search, { delay: 30 });
  const optionSel = ".select__option:visible";
  const w = wanted.toLowerCase();
  const rank = (t: string) => {
    const s = t.toLowerCase().replace(/\s+/g, " ").trim();
    if (s === w) return 0;
    if (s.startsWith(w)) return 1;
    if (
      ` ${s.replace(/[^a-z0-9]+/g, " ")} `.includes(
        ` ${w.replace(/[^a-z0-9]+/g, " ").trim()} `,
      )
    )
      return 2;
    if (s.includes(w)) return 3;
    if (s === "other") return 8; // last-resort fallback for school / discipline
    return 9;
  };
  for (let i = 0; i < 50; i++) {
    const texts = await frame
      .locator(optionSel)
      .allTextContents()
      .catch(() => [] as string[]);
    const best = texts
      .map((t, idx) => [rank(t), idx] as const)
      .filter(([r]) => r < 9)
      .sort((a, b) => a[0] - b[0])[0];
    if (best && (best[0] < 8 || i > 20)) {
      const picked = texts[best[1]].trim();
      await frame.locator(optionSel).nth(best[1]).click({ timeout: 5000 });
      return { ok: true, picked };
    }
    await page.waitForTimeout(100);
  }
  await page.keyboard.press("Escape");
  return { ok: false, picked: "" };
}

async function formFrame(page: Page): Promise<Frame | null> {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames())
      if (
        await f
          .evaluate(() => !!document.getElementById("first_name"))
          .catch(() => false)
      )
        return f;
    await page.waitForTimeout(500);
  }
  return null;
}

const browser = await chromium.launch({
  headless: !HEADED,
  slowMo: HEADED ? 120 : 0,
});
const rl = HEADED
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null;
const candidates = jobs
  .filter((j) => j.status !== "applied")
  .sort((a, b) => (b.sc ?? 0) - (a.sc ?? 0))
  .slice(0, ONLY);
const totals = { filled: 0, planned: 0, needsYou: 0, jobs: 0 };

try {
  for (const job of candidates) {
    console.log(
      `\n=== ${job.employer} · ${job.title} (score ${Math.round(job.sc ?? 0)}, ${job.status})`,
    );
    const { url, how } = await resolveGreenhouseUrl(job).catch((e) => ({
      url: null,
      how: `resolver error: ${String(e).slice(0, 60)}`,
    }));
    console.log(`  resolver: ${how}${url ? ` → ${url}` : ""}`);
    if (!url) continue;
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.route("**/*", (r) =>
      r.request().method() === "GET" ? r.continue() : r.abort(),
    );
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    for (const reveal of ["Application", "Apply now", "Apply"]) {
      if (await page.evaluate(() => !!document.getElementById("first_name")))
        break;
      const el = page
        .getByRole("tab", { name: reveal })
        .or(page.getByRole("button", { name: reveal }))
        .first();
      if (await el.count()) {
        await el.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
    }
    const frame = await formFrame(page);
    if (!frame) {
      console.log("  form not found (posting may be closed)");
      await page.close();
      continue;
    }

    const fields = await frame.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLInputElement>(
          "input[id], textarea[id]",
        ),
      ]
        .filter((el) => el.type !== "hidden" && !el.id.startsWith("iti-"))
        .map(
          (el) =>
            [
              el.id,
              (
                document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
                  ?.textContent ?? ""
              )
                .trim()
                .replace(/\s+/g, " "),
            ] as [string, string],
        ),
    );
    const labels = new Map(fields);
    const { plan, needsYou } = buildPlan(new Set(labels.keys()), labels);
    let filled = 0;
    for (const item of plan) {
      let ok = false;
      let shown = "";
      try {
        if (item.kind === "text") {
          await clickField(frame, `[id="${item.id}"]`);
          await page.keyboard.press("Control+A");
          await page.keyboard.insertText(item.value);
          const got = await frame.evaluate(
            (i) =>
              (document.getElementById(i) as HTMLInputElement)?.value ?? "",
            item.id,
          );
          ok =
            item.id === "phone"
              ? got.replace(/\D/g, "").endsWith(item.value.replace(/\D/g, ""))
              : got === item.value;
          shown = mask(got);
        } else if (item.kind === "select") {
          const r = await trustedSelect(
            frame,
            item.id,
            item.value,
            item.search ?? item.value,
          );
          ok = r.ok;
          shown =
            item.source === "default" ||
            item.id.startsWith("degree") ||
            item.id.startsWith("discipline")
              ? r.picked
              : mask(r.picked);
        } else if (item.kind === "repeat") {
          const before = await frame.locator('[id^="school--"]').count();
          await frame
            .getByRole("button", { name: /add another/i })
            .first()
            .click({ timeout: 5000 });
          ok = (await frame.locator('[id^="school--"]').count()) > before;
          shown = "added";
        } else if (item.kind === "file") {
          await frame.locator('[id="resume"]').setInputFiles({
            name: "Resume.pdf",
            mimeType: "application/pdf",
            buffer: pdf,
          });
          await page.waitForTimeout(1500);
          const name = await frame.evaluate(
            () =>
              (document.getElementById("resume") as HTMLInputElement)
                ?.files?.[0]?.name ?? "",
          );
          ok = true; // attach was triggered; Greenhouse uploads immediately, which the dry run blocks
          shown = name
            ? "tailored PDF attached (upload blocked)"
            : "attach triggered → upload blocked by dry run, Greenhouse reset the box (expected)";
        }
      } catch (e) {
        shown = `error ${String(e).slice(0, 50)}`;
      }
      if (ok) filled++;
      console.log(
        `  ${ok ? "✓" : "✗"} ${item.kind.padEnd(6)} ${item.id.padEnd(22)} ← ${item.source.padEnd(17)} ${shown}`,
      );
    }
    console.log(
      `  filled ${filled}/${plan.length} planned fields · needs you (no answer bank yet): ${needsYou.length}`,
    );
    for (const q of needsYou.slice(0, 12))
      console.log(`     ? ${q.slice(0, 90)}`);
    totals.filled += filled;
    totals.planned += plan.length;
    totals.needsYou += needsYou.length;
    totals.jobs++;
    if (rl)
      await rl.question(
        "  [headed] look at the browser, then press Enter for the next job… ",
      );
    await page.close();
  }
} finally {
  rl?.close();
  await browser.close();
}
console.log(
  `\n=== ${totals.jobs} forms · filled ${totals.filled}/${totals.planned} planned fields · ${totals.needsYou} questions need the answer bank`,
);
