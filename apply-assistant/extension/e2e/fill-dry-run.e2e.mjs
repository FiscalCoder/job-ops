// Dry run of a supervised fill on a REAL application form (Greenhouse or Ashby), driven through
// the built extension. Every non-GET request is blocked except to the apply-assistant server and
// Ashby's read-only form queries (anything that submits, uploads or creates stays blocked), so
// nothing is uploaded and nothing can be submitted. Steps that need you are skipped; the run is
// aborted at review.
//
// Stub mode (a system none of your jobs is on yet): STUB_PLAN=<plan.json> STUB_URL=<posting url>
// STUB_ATS=lever replaces the apply-assistant server with a local stub serving that plan (built
// from a real form with FAKE details), so the real form is filled and nothing of yours is used.
//   node e2e/fill-dry-run.e2e.mjs <screenshot-dir> [job title substring]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const shots = process.argv[2];
const jobTitle = process.argv[3] ?? "Senior Full Stack Developer";
const SERVER_HOST = "apply.hueint.com";
const mask = (v) => (v.length <= 2 ? v : `${v[0]}***(${v.length})`);

const profile = mkdtempSync(path.join(tmpdir(), "copilot-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});
const blocked = [];
const allowedPosts = [];
// Ashby loads the form with GraphQL POSTs named by ?op=; only reads are let through.
const READ_ONLY_ASHBY = (url) =>
  url.host === "jobs.ashbyhq.com" &&
  url.pathname === "/api/non-user-graphql" &&
  !/submit|upload|create|apply|mutat|file|update|delete|save|set/i.test(
    url.searchParams.get("op") ?? "submit",
  );
const STUB = process.env.STUB_PLAN
  ? {
      plan: JSON.parse(readFileSync(process.env.STUB_PLAN, "utf8")),
      url: process.env.STUB_URL,
      ats: process.env.STUB_ATS ?? "greenhouse",
    }
  : null;
const stubServer = (route, url) => {
  const ok = (data) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data }),
    });
  if (url.pathname === "/queue")
    return ok([
      {
        jobId: "stub",
        title: jobTitle,
        employer: "Stub",
        score: 80,
        target: { ats: STUB.ats, status: "matched", postingUrl: STUB.url },
        plan: { summary: STUB.plan.summary, builtAt: "now" },
      },
    ]);
  if (url.pathname === "/plans/stub") return ok(STUB.plan);
  if (url.pathname === "/runs" && route.request().method() === "POST")
    return ok({ id: "stub-run" });
  if (url.pathname.startsWith("/runs/")) return ok({});
  if (url.pathname === "/jobs/stub/resume.pdf")
    return route.fulfill({
      status: 200,
      contentType: "application/pdf",
      headers: {
        "content-disposition":
          'attachment; filename="Test_Candidate_Resume.pdf"',
      },
      body: Buffer.from(
        ["%PDF-1.4", "% fake resume for a dry run", "%%EOF", ""].join("\n"),
      ),
    });
  return ok([]);
};
await context.route("**/*", (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (STUB && url.host === SERVER_HOST) return stubServer(route, url);
  if (req.method() === "GET" || url.host === SERVER_HOST)
    return route.continue();
  if (READ_ONLY_ASHBY(url)) {
    allowedPosts.push(url.searchParams.get("op"));
    return route.continue();
  }
  blocked.push(
    `${req.method()} ${url.host}${url.pathname}${url.search.slice(0, 40)}`,
  );
  return route.abort();
});

const worker =
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const panel = await context.newPage();
const errors = [];
panel.on("pageerror", (e) => errors.push(e.message));
await panel.goto(
  `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
);
if (STUB) {
  await worker.evaluate(() =>
    chrome.storage.local.set({
      serverUrl: "https://apply.hueint.com",
      token: "stub",
    }),
  );
  await panel.reload();
} else {
  await panel.getByLabel("Username").fill(process.env.username ?? "");
  await panel.getByLabel("Password").fill(process.env.password ?? "");
  await panel.getByRole("button", { name: "Sign in" }).click();
}
// HERE=<application url>: you're already on the form (LinkedIn's Apply took you there), so the
// run starts from the side panel's "Fill this page" and fills that same tab.
const here = process.env.HERE;
let posting;
if (here) {
  await panel.locator("#queue li.clickable", { hasText: jobTitle }).waitFor();
  await worker.evaluate(() =>
    chrome.storage.local.set({ countdownSeconds: 1 }),
  );
  posting = await context.newPage();
  await posting.goto(here);
  const tabsBefore = context.pages().length;
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Fill this page" }).click();
  await panel
    .locator("#run-box")
    .getByText("Timeline")
    .waitFor({ timeout: 60_000 });
  if (context.pages().length !== tabsBefore)
    throw new Error(
      "Fill this page opened a new tab instead of using this one",
    );
} else {
  await panel
    .locator("#queue li.clickable", { hasText: jobTitle })
    .first()
    .click();
  await panel.getByRole("button", { name: "Start supervised fill" }).waitFor();
  await panel.locator("#plan select").selectOption("1");
  const postingPromise = context.waitForEvent("page");
  await panel.getByRole("button", { name: "Start supervised fill" }).click();
  posting = await postingPromise;
}

const clicks = [];
const skipped = [];
const typed = [];
const answers = Object.entries(JSON.parse(process.env.ANSWERS ?? "{}"));
// Optional trace of one field while the run works (WATCH=candidate-location).
const watchId = process.env.WATCH;
let lastSeen = "";
const watch = async () => {
  if (!watchId) return;
  for (const frame of posting.frames()) {
    const seen = await frame
      .evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const single =
          el.closest(".select__control")?.querySelector(".select__single-value")
            ?.textContent ?? "";
        return `typed="${el.value}" chosen="${single}" menu=${!!document.querySelector(".select__menu")} step=${document.getElementById("ac-badge")?.textContent ?? ""}`;
      }, watchId)
      .catch(() => null);
    if (seen && seen !== lastSeen) {
      lastSeen = seen;
      console.log(
        `[watch ${((Date.now() - started) / 1000).toFixed(1)}s] ${seen}`,
      );
    }
  }
};
const started = Date.now();
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  const text =
    (await panel
      .locator("#run-box")
      .textContent()
      .catch(() => "")) ?? "";
  if (text.includes("click Submit yourself")) break;
  if (
    /No application form|took too long|Couldn't/.test(text) &&
    !text.includes("Timeline")
  ) {
    console.log("run failed to start:", text.slice(0, 200));
    break;
  }
  const approve = panel.getByRole("button", { name: "Approve", exact: true });
  const readLabel = async () =>
    (await panel
      .locator(".step-card strong")
      .first()
      .textContent()
      .catch(() => "")) ?? "";
  const firstRead = await readLabel();
  await panel.waitForTimeout(300);
  const currentLabel = await readLabel();
  if (currentLabel !== firstRead) continue;
  const skip = panel.getByRole("button", { name: "Skip", exact: true });
  const label = async () =>
    (await panel
      .locator(".step-card strong")
      .first()
      .textContent()
      .catch(() => "")) ?? "";
  if (
    (await approve.isVisible().catch(() => false)) &&
    (await approve.isEnabled().catch(() => false))
  ) {
    clicks.push(await label());
    await approve.click().catch(() => {});
  } else if (
    // ANSWERS='{"How did you hear":"LinkedIn"}' types an answer into a needs-you step, as you would.
    answers.length &&
    (await panel.locator(".step-card .value").count()) === 0 &&
    answers.some(([q]) => currentLabel.includes(q))
  ) {
    const answer = answers.find(([q]) => currentLabel.includes(q))?.[1] ?? "";
    await panel.locator(".step-card form input").fill(answer);
    await panel.getByRole("button", { name: "Use this" }).click();
    answers.splice(
      answers.findIndex(([q]) => currentLabel.includes(q)),
      1,
    );
    // Wait for the step to finish, then note what the panel says about it.
    await panel.waitForTimeout(6000);
    const after =
      (await panel
        .locator(".step-card")
        .first()
        .textContent()
        .catch(() => "")) ?? "";
    typed.push(
      `${currentLabel} ← ${answer} → ${after.includes(currentLabel) ? `still here: ${after.slice(0, 160)}` : "done"}`,
    );
  } else if (
    // Steps with no answer to approve (the card shows no value) need you; so does a step whose
    // Approve is greyed out after two failed tries. Both are skipped and reported.
    (await skip.isVisible().catch(() => false)) &&
    !(await panel
      .getByRole("button", { name: "Approve now" })
      .isVisible()
      .catch(() => false)) &&
    ((await panel.locator(".step-card .value").count()) === 0 ||
      ((await approve.isVisible().catch(() => false)) &&
        !(await approve.isEnabled().catch(() => true))))
  ) {
    skipped.push(
      `${await label()}: ${
        (await panel
          .locator(".step-card .error, .step-card .muted")
          .first()
          .textContent()
          .catch(() => "")) ?? ""
      }`,
    );
    await skip.click().catch(() => {});
  }
  await watch();
  await panel.waitForTimeout(150);
}

await panel.waitForTimeout(2500); // review re-checks every field before it shows problems
const runText = (await panel.locator("#run-box").textContent()) ?? "";
const timeline = await panel.locator(".timeline li").allTextContents();
if (shots) {
  await posting.screenshot({
    path: path.join(shots, "dry-run-form.png"),
    fullPage: true,
  });
  await panel.screenshot({
    path: path.join(shots, "dry-run-panel.png"),
    fullPage: true,
  });
}
// Read the real form back, independently of the extension.
const form =
  posting.frames().find((f) => f.url().includes("greenhouse")) ??
  posting.mainFrame();
const readBack = await form.evaluate(() => {
  // Ashby: every field container carries its path.
  const entries = [...document.querySelectorAll("[data-field-path]")];
  if (entries.length)
    return Object.fromEntries(
      entries.map((entry) => {
        const label =
          entry.querySelector("label")?.textContent?.trim().slice(0, 40) ??
          entry.dataset.fieldPath;
        const file = entry.querySelector("input[type=file]");
        const checked = [...entry.querySelectorAll("input:checked")]
          .map((i) =>
            document
              .querySelector(`label[for="${CSS.escape(i.id)}"]`)
              ?.textContent?.trim(),
          )
          .join(", ");
        const text = entry.querySelector(
          "input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea",
        );
        return [
          label,
          file
            ? (file.files?.[0]?.name ??
              entry.textContent?.trim().slice(0, 60) ??
              null)
            : checked || text?.value || null,
        ];
      }),
    );
  // Lever: fields by name, choices by their checked value.
  const lever = document.querySelector("form#application-form");
  if (lever) {
    const out = {};
    for (const el of lever.querySelectorAll("input, textarea, select")) {
      if (!el.name || el.type === "hidden" || el.type === "file") continue;
      if ((el.type === "radio" || el.type === "checkbox") && !el.checked)
        continue;
      if (el.value)
        out[el.name.replace(/^cards\[([0-9a-f]{8})[^\]]*\]/, "card-$1")] =
          el.value;
    }
    out.selectedLocation = lever.querySelector("#selected-location")?.value
      ? "set"
      : null;
    return out;
  }
  const val = (sel) => document.querySelector(sel)?.value ?? null;
  const shown = (sel) =>
    document
      .querySelector(sel)
      ?.closest(".select__control, .select-shell, .select")
      ?.querySelector(".select__single-value")
      ?.textContent?.trim() ?? null;
  const questions = [...document.querySelectorAll("[id^=question_]")].map(
    (el) => [el.id, el.value || shown(`[id="${el.id}"]`)],
  );
  return {
    first_name: val("#first_name"),
    last_name: val("#last_name"),
    email: val("#email"),
    phone: val("#phone"),
    country: shown("#country"),
    location: shown("#candidate-location"),
    locationTyped: val("#candidate-location"),
    resume:
      document.querySelector("#resume")?.files?.[0]?.name ??
      document
        .querySelector("[class*=file] , .resume")
        ?.textContent?.trim()
        ?.slice(0, 60) ??
      null,
    questions,
  };
});
await panel
  .getByRole("button", { name: "Abort" })
  .click()
  .catch(() => {});
// The run is over once the server has it (its trace is sent first).
await panel
  .getByText(/Nothing was submitted|Couldn't record the end/)
  .waitFor({ timeout: 60_000 })
  .catch(() => {});
const endText = (await panel.locator("#run-box").textContent()) ?? "";

console.log(
  JSON.stringify(
    {
      reachedReview: runText.includes("click Submit yourself"),
      approvalsClicked: clicks.length,
      skippedNeedsYou: skipped,
      typedAnswers: typed,
      timeline,
      readBack: Object.fromEntries(
        Object.entries(readBack).map(([k, v]) => [
          k,
          Array.isArray(v)
            ? v.map(([id, x]) => [id, x ? mask(String(x)) : x])
            : v
              ? mask(String(v))
              : v,
        ]),
      ),
      problemsAtReview: [...runText.matchAll(/On the page: ([^.]*)/g)].map(
        (m) => m[1],
      ),
      afterAbort: endText.slice(0, 160),
      blockedRequests: [...new Set(blocked)],
      allowedAshbyQueries: [...new Set(allowedPosts)],
      errors,
    },
    null,
    1,
  ),
);
await context.close();
rmSync(profile, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
});
