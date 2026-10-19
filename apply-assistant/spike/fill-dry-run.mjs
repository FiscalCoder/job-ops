// M0 spike: dry-run the Greenhouse fillers on live forms with FAKE data.
// Safety: every non-GET request is aborted (nothing can be posted or uploaded),
// and no code path clicks Submit. Usage: node apply-assistant/spike/fill-dry-run.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILLERS = path.join(
  here,
  "../extension/src/content/fillers/greenhouse.ts",
);

const FAKE = {
  first: "Test",
  last: "Candidate",
  email: "test.candidate@example.com",
  phone: "9876543210",
};

// One plan per live form. Option texts are best guesses; "no_option" results show
// what the form actually offers, which is exactly what the spike needs to learn.
const PLANS = [
  {
    name: "New Relic (job board page, has Education section)",
    url: "https://job-boards.greenhouse.io/newrelic/jobs/5453390008",
    steps: [
      ["text", "first_name", FAKE.first],
      ["text", "last_name", FAKE.last],
      ["text", "preferred_name", FAKE.first],
      ["text", "email", FAKE.email],
      ["select", "country", "India"],
      ["text", "phone", FAKE.phone],
      ["select", "candidate-location", "Bengaluru", "Bengaluru"],
      ["file", "resume", "Test_Candidate_Resume.pdf"],
      [
        "select",
        "school--0",
        "Visvesvaraya Technological University",
        "Visvesvaraya",
      ],
      ["select", "degree--0", "Bachelor's Degree"],
      ["select", "discipline--0", "Computer Science"],
      ["repeat", "school--"],
      ["select", "question_18984069008", "India"],
      ["select", "question_18984072008", "No"],
      ["select", "question_18984075008", "No"],
      ["select", "gender", "Decline To Self Identify", "Decline"],
    ],
  },
  {
    name: "Fivetran (Greenhouse embedded in company careers page)",
    url: "https://www.fivetran.com/careers/job?gh_jid=7790795003",
    steps: [
      ["text", "first_name", FAKE.first],
      ["text", "last_name", FAKE.last],
      ["text", "email", FAKE.email],
      ["select", "country", "India"],
      ["text", "phone", FAKE.phone],
      ["file", "resume", "Test_Candidate_Resume.pdf"],
      ["text", "question_31232841003", "1 Test Street"],
      ["text", "question_31232843003", "Bengaluru"],
      ["checkbox", "question_31232849003[]", ["No Preference"]],
      ["select", "question_31232850003", "LinkedIn"],
      ["select", "question_31232854003", "Yes"],
    ],
  },
];

async function bundleFillers() {
  const out = await build({
    entryPoints: [FILLERS],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "GHFill",
    target: "es2020",
  });
  return out.outputFiles[0].text;
}

async function formFrame(page) {
  for (let i = 0; i < 30; i++) {
    for (const frame of page.frames()) {
      const has = await frame
        .evaluate(() => Boolean(document.getElementById("first_name")))
        .catch(() => false);
      if (has) return frame;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function runStep(frame, step) {
  const [kind, id, value, search] = step;
  return frame.evaluate(
    async ({ kind, id, value, search }) => {
      const doc = document;
      const F = globalThis.GHFill;
      if (kind === "text") return F.fillText(doc, id, value);
      if (kind === "select")
        return F.selectOption(doc, id, value, search ?? value);
      if (kind === "checkbox") return F.checkBoxes(doc, id, value);
      if (kind === "repeat") return F.clickAddAnother(doc, id);
      if (kind === "file") {
        const pdf = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF";
        return F.attachFile(
          doc,
          id,
          new File([pdf], value, { type: "application/pdf" }),
        );
      }
      return { fieldId: id, kind, status: "error", detail: "unknown step" };
    },
    { kind, id, value, search },
  );
}

const bundle = await bundleFillers();
const browser = await chromium.launch();
const summary = {};
try {
  for (const plan of PLANS) {
    const page = await browser.newPage();
    const blocked = [];
    await page.route("**/*", (route) => {
      const req = route.request();
      if (req.method() === "GET") return route.continue();
      blocked.push(`${req.method()} ${req.url().slice(0, 80)}`);
      return route.abort();
    });
    console.log(`\n=== ${plan.name}\n    ${plan.url}`);
    await page.goto(plan.url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    const frame = await formFrame(page);
    if (!frame) {
      console.log("  form not found");
      await page.close();
      continue;
    }
    console.log(
      `    form frame: ${frame === page.mainFrame() ? "main page" : frame.url().slice(0, 70)}`,
    );
    await frame.evaluate(bundle);
    for (const step of plan.steps) {
      const r = await runStep(frame, step).catch((e) => ({
        fieldId: step[1],
        kind: step[0],
        status: "error",
        detail: String(e).slice(0, 120),
      }));
      summary[r.kind] ??= { ok: 0, total: 0 };
      summary[r.kind].total++;
      if (r.status === "ok") summary[r.kind].ok++;
      console.log(
        `  ${r.status === "ok" ? "✓" : "✗"} ${r.kind.padEnd(8)} ${String(r.fieldId).padEnd(24)} want="${r.requested ?? ""}" got="${r.readBack ?? ""}" ${r.status}${r.detail ? ` (${r.detail})` : ""}`,
      );
    }
    const empty = await frame.evaluate(() =>
      globalThis.GHFill.emptyRequired(document),
    );
    console.log(
      `  required still empty: ${empty.length ? empty.join(", ") : "none"}`,
    );
    console.log(
      `  non-GET requests blocked: ${blocked.length}${blocked.length ? ` → ${[...new Set(blocked.map((b) => b.split(" ")[1].split("?")[0]))].slice(0, 4).join(", ")}` : ""}`,
    );
    await page.screenshot({
      path: path.join(here, `out-${plan.name.split(" ")[0].toLowerCase()}.png`),
      fullPage: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("\n=== by field type");
for (const [kind, v] of Object.entries(summary))
  console.log(`  ${kind.padEnd(9)} ${v.ok}/${v.total}`);
