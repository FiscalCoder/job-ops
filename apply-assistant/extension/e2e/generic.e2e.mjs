// A supervised fill of a FAKE company careers page (no known application system) through the
// built extension: fields read generically, planned by a stub server, filled with trusted
// input; a custom dropdown the extension can't read is filled with "Claude's" steps (stubbed),
// which become the site's recipe and are replayed without Claude on the next run; steps that
// would click Submit are refused. Nothing real is contacted.
//   node e2e/generic.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const SERVER_HOST = "apply.hueint.com";
// The extension may already script its server's host, so the fake site lives there.
const FORM_URL = `https://${SERVER_HOST}/test/careers/jobs/123/apply`;

const FORM = String.raw`<!doctype html><html><head><title>Acme Careers</title>
<style>.field{margin:12px 0} [role=listbox]{position:absolute;background:#fff;border:1px solid #888;list-style:none;margin:0;padding:4px}
[role=option]{padding:4px 8px;cursor:pointer} .menu{border:1px solid #888;list-style:none;padding:4px} .item{padding:4px;cursor:pointer}</style></head><body>
<h1>Apply for Senior Engineer</h1>
<form id="form" onsubmit="return false">
  <div class="field"><label for="fn">First name *</label><input id="fn" name="first_name" required></div>
  <div class="field"><label for="ln">Last name *</label><input id="ln" name="last_name" required></div>
  <div class="field"><input type="email" aria-label="Email address" name="email"></div>
  <div class="field"><label for="tel">Phone</label><input id="tel" type="tel" name="phone"></div>
  <div class="field"><label for="cv">Resume/CV *</label><button type="button">Upload</button><input id="cv" type="file" name="cv" style="display:none"><span id="cv-name"></span></div>
  <div class="field"><label for="country">Country</label>
    <select id="country"><option value="">Select…</option><option value="IN">India</option><option value="US">United States</option></select></div>
  <div class="field loc-container"><label id="loc-label">Current location</label>
    <div class="loc__single-value" id="loc-value"></div>
    <input id="loc" role="combobox" aria-autocomplete="list" aria-labelledby="loc-label"></div>
  <div class="field dd-field"><label id="np">Notice period</label>
    <div class="dd" role="combobox" aria-labelledby="np" tabindex="0">Select…</div>
    <ul class="menu" hidden><li class="item" data-v="Immediately">Immediately</li><li class="item" data-v="30 days">30 days</li><li class="item" data-v="60 days">60 days</li></ul></div>
  <div class="field"><label for="start">Start date</label><input id="start" type="date" name="start"></div>
  <fieldset class="field"><legend>Years of experience *</legend>
    <label><input type="radio" name="years" value="a"> 0-2</label>
    <label><input type="radio" name="years" value="b"> 3-5</label>
    <label><input type="radio" name="years" value="c"> 5+</label></fieldset>
  <div class="field"><label><input type="checkbox" name="privacy"> I agree to the privacy notice</label></div>
  <button type="submit" id="submit">Submit application</button>
</form>
<script>
const $ = (s) => document.querySelector(s);
window.submitClicks = 0;
$("#submit").addEventListener("click", () => {
  window.submitClicks++;
  if (window.allowSubmit) document.body.innerHTML = "<h1>Thank you for applying!</h1><p>Your application has been submitted.</p>";
});
$("#cv").addEventListener("change", () => { $("#cv-name").textContent = [...$("#cv").files].map((f) => f.name).join(","); });
// A searchable location: its choices open in a list at the end of the page once you type.
const loc = $("#loc");
loc.addEventListener("input", () => {
  document.querySelectorAll("[role=listbox][data-popup]").forEach((l) => l.remove());
  if (loc.value.length < 2) return;
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  list.setAttribute("data-popup", "");
  for (const place of ["Bengaluru, Karnataka", "Bengaluru Rural", "Chennai, Tamil Nadu"].filter((p) => p.toLowerCase().includes(loc.value.toLowerCase()))) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.textContent = place;
    li.addEventListener("click", () => { $("#loc-value").textContent = place; loc.value = ""; list.remove(); });
    list.append(li);
  }
  document.body.append(list);
});
// A custom dropdown whose items aren't marked as options: the extension can't read it.
$(".dd").addEventListener("click", () => { $(".menu").hidden = false; });
for (const item of document.querySelectorAll(".item"))
  item.addEventListener("click", () => { $(".dd").textContent = item.dataset.v; $(".menu").hidden = true; });
</script></body></html>`;

/** The stub server's plan: what each question gets (by its label). */
const VALUES = {
  "First name": "Testy",
  "Last name": "User",
  "Email address": "test@example.com",
  Phone: "9876543210",
  Country: "India",
  "Current location": "Bengaluru",
  "Notice period": "30 days",
  "Start date": "2026-11-20",
  "Years of experience": "5+",
  "I agree to the privacy notice": "I agree to the privacy notice",
};

const posted = [];
const actAsks = [];
const recipes = new Map();
const recipeResults = [];
/** The extension's trail (its failures are printed when a check fails). */
const trail = [];
const ok = (route, data) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
// "Add a job": a job's page that isn't open, read in a background tab.
const JOB_URL = `https://${SERVER_HOST}/test/jobs/456`;
const JOB_PAGE = `<!doctype html><html><head><title>Platform Engineer - Acme</title>
<meta property="og:site_name" content="Acme"></head><body><nav>Home Jobs</nav>
<main><h1>Platform Engineer</h1><p>${"Run our Kubernetes platform in Chennai. ".repeat(10)}</p></main></body></html>`;
const reads = [];
const imports = [];

function stubServer(route, url) {
  const req = route.request();
  if (url.pathname === "/test/jobs/456")
    return route.fulfill({ status: 200, contentType: "text/html", body: JOB_PAGE });
  if (url.pathname === "/jobs/import/read") {
    reads.push(JSON.parse(req.postData() ?? "{}"));
    return ok(route, {
      job: { title: "Platform Engineer", employer: "Acme", location: "Chennai" },
      warning: null,
    });
  }
  if (url.pathname === "/jobs/import") {
    imports.push(JSON.parse(req.postData() ?? "{}").job);
    return ok(route, { jobId: "new-job", status: "processing" });
  }
  if (url.pathname.startsWith("/test/careers"))
    return route.fulfill({ status: 200, contentType: "text/html", body: FORM });
  if (url.pathname === "/queue")
    return ok(route, [
      {
        jobId: "stub",
        title: "Senior Engineer",
        employer: "Acme",
        score: 80,
        jobUrl: FORM_URL,
        applicationLink: null,
        target: { status: "none" },
        plan: null,
      },
    ]);
  if (url.pathname === "/jobs/stub/resume.pdf")
    return route.fulfill({
      status: 200,
      contentType: "application/pdf",
      headers: { "content-disposition": 'attachment; filename="Resume.pdf"' },
      body: Buffer.from("%PDF-1.4 stub"),
    });
  if (url.pathname === "/plans/stub/page") {
    const page = req.postDataJSON();
    posted.push(page);
    return ok(route, {
      schemaHash: "x",
      jobCountry: null,
      summary: {},
      add: [],
      entries: page.fields.map((f) => ({
        ref: f.ref,
        label: f.label,
        section: "main",
        type: f.kind === "file" ? "file" : f.kind === "text" ? "text" : "select",
        required: f.required,
        actionClass: "auto",
        status: f.kind === "file" || VALUES[f.label] ? "fill" : "skip",
        value: f.kind === "file" ? "Tailored resume (PDF from Job Ops)" : (VALUES[f.label] ?? null),
        optionValues: null,
        source: f.kind === "file" ? "jobops:tailored-pdf" : "bank:stub",
      })),
    });
  }
  if (url.pathname === "/plans/stub/act") {
    const ask = req.postDataJSON();
    actAsks.push(ask);
    // "Claude": the custom dropdown is opened and its item clicked; for the date, a step that
    // would click Submit (which the extension must refuse).
    return ok(route, {
      steps:
        ask.label === "Notice period"
          ? [
              { action: "click", value: ".dd" },
              { action: "click", value: `li.item[data-v='${ask.wanted}']` },
            ]
          : [{ action: "click", value: "#submit" }],
      why: "stub",
    });
  }
  if (url.pathname.startsWith("/trace")) {
    try {
      trail.push(...(req.postDataJSON()?.events ?? []));
    } catch {}
    return ok(route, {});
  }
  if (url.pathname === "/recipes" && req.method() === "GET")
    return ok(route, [...recipes.values()]);
  if (url.pathname === "/recipes" && req.method() === "POST") {
    const result = req.postDataJSON();
    recipeResults.push(result);
    const key = result.label.toLowerCase();
    const before = recipes.get(key) ?? { labelKey: key, steps: result.steps, worked: 0, failed: 0 };
    recipes.set(key, {
      ...before,
      steps: result.ok ? result.steps : before.steps,
      worked: before.worked + (result.ok ? 1 : 0),
      failed: before.failed + (result.ok ? 0 : 1),
    });
    return ok(route, recipes.get(key));
  }
  if (url.pathname === "/runs" && req.method() === "POST")
    return ok(route, { id: "stub-run" });
  if (url.pathname.startsWith("/runs/")) return ok(route, {});
  return ok(route, []);
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-generic-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});
const failures = [];
let shownOnFailure = null;
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures.push(name);
};

try {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host === SERVER_HOST) return stubServer(route, url);
    if (url.protocol === "chrome-extension:") return route.continue();
    return route.abort();
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() =>
    chrome.storage.local.set({
      serverUrl: "https://apply.hueint.com",
      token: "stub",
      countdownSeconds: 1,
    }),
  );
  const panel = await context.newPage();
  shownOnFailure = () => panel.locator("body").innerText();
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  await panel.locator("#queue li", { hasText: "Senior Engineer" }).first().waitFor();

  const form = await context.newPage();
  await form.goto(FORM_URL);
  await panel.bringToFront();
  const fill = panel.locator("#here").getByRole("button", { name: "Fill this page" });
  await fill.waitFor({ timeout: 15_000 });
  check("Fill this page offered on the company's own page", true);
  await fill.click();

  // The date: "Claude's" steps would click Submit, so they're refused and the step waits for
  // you; you skip it.
  const skip = panel.getByRole("button", { name: "Skip" });
  await panel
    .getByText("Claude's steps didn't set it either", { exact: false })
    .waitFor({ timeout: 90_000 });
  check(
    "a step that would click Submit is refused",
    (await form.evaluate(() => window.submitClicks)) === 0,
  );
  await skip.click();
  await panel
    .getByText("Check this page, then continue or submit it there yourself", { exact: false })
    .waitFor({ timeout: 60_000 });

  const page = posted[0];
  check(
    "the page read generically",
    page?.system === "generic" &&
      page.fields.map((f) => f.label).join("|") ===
        "First name|Last name|Email address|Phone|Resume/CV|Country|Current location|Notice period|Start date|Years of experience|I agree to the privacy notice",
    page?.fields.map((f) => `${f.label}:${f.kind}`).join(", "),
  );
  const shown = await form.evaluate(() => ({
    first: document.querySelector("#fn").value,
    last: document.querySelector("#ln").value,
    email: document.querySelector("[name=email]").value,
    phone: document.querySelector("#tel").value,
    cv: document.querySelector("#cv-name").textContent,
    country: document.querySelector("#country").value,
    location: document.querySelector("#loc-value").textContent,
    notice: document.querySelector(".dd").textContent,
    years: document.querySelector("input[name=years]:checked")?.parentElement.textContent.trim(),
    privacy: document.querySelector("[name=privacy]").checked,
  }));
  check(
    "text, phone, upload, select, radio and checkbox filled",
    shown.first === "Testy" &&
      shown.last === "User" &&
      shown.email === "test@example.com" &&
      shown.phone === "9876543210" &&
      shown.cv === "Resume.pdf" &&
      shown.country === "IN" &&
      shown.years === "5+" &&
      shown.privacy === true,
    JSON.stringify(shown),
  );
  check(
    "a searchable location picked from the list that opened",
    shown.location === "Bengaluru, Karnataka",
    shown.location,
  );
  check(
    "a dropdown it can't read filled with Claude's steps",
    shown.notice === "30 days" &&
      actAsks.some(
        (a) => a.label === "Notice period" && a.html.includes('data-ac-target="1"'),
      ),
    `${shown.notice} · ${actAsks.map((a) => a.label).join(", ")}`,
  );
  const kept = recipes.get("notice period");
  check(
    "Claude's steps kept as this site's recipe, without your answer",
    kept?.worked === 1 && JSON.stringify(kept.steps).includes("{value}") &&
      !JSON.stringify(kept.steps).includes("30 days"),
    JSON.stringify(kept),
  );

  // You submit; the run notices the confirmation.
  await form.evaluate(() => {
    window.allowSubmit = true;
  });
  await form.locator("#submit").click();
  await panel.getByText("Marked as applied", { exact: false }).waitFor({ timeout: 30_000 });
  check("the run ends when you submit", true);

  // Next application on this site: the recipe fills Notice period, without Claude.
  const asksBefore = actAsks.filter((a) => a.label === "Notice period").length;
  await panel.getByRole("button", { name: "Close" }).click();
  await form.goto(FORM_URL);
  await panel.bringToFront();
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).waitFor({ timeout: 15_000 });
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).click();
  await panel
    .getByText("Claude's steps didn't set it either", { exact: false })
    .waitFor({ timeout: 90_000 });
  const notice = await form.evaluate(() => document.querySelector(".dd").textContent);
  check(
    "next time, the site's recipe fills it without Claude",
    notice === "30 days" &&
      actAsks.filter((a) => a.label === "Notice period").length === asksBefore &&
      recipes.get("notice period")?.worked === 2,
    `${notice} · asks ${actAsks.filter((a) => a.label === "Notice period").length} · ${JSON.stringify(recipes.get("notice period"))}`,
  );
  // Add a job from its link: read in a background tab, Job Ops reads its details, you add it.
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Abort" }).click();
  await panel.getByRole("button", { name: "Close" }).click();
  const tabsBefore = context.pages().length;
  await panel.locator("#import-url").fill("https://www.linkedin.com/jobs/view/1");
  await panel.locator("#import-form").getByRole("button", { name: "Add" }).click();
  await panel.getByText("LinkedIn and Indeed pages aren't read", { exact: false }).waitFor();
  check("a LinkedIn link isn't read", reads.length === 0);
  // A link that isn't open: read in a background tab, then closed. (Pages the extension opens
  // aren't stubbed: the server's own sign-in reply is too short to be a job, as it should be.)
  await panel.locator("#import-url").fill(`https://${SERVER_HOST}/queue`);
  await panel.locator("#import-form").getByRole("button", { name: "Add" }).click();
  await panel.getByText("That page shows hardly any text", { exact: false }).waitFor({ timeout: 45_000 });
  check(
    "a link that isn't open is read in a background tab, closed afterwards",
    context.pages().length === tabsBefore && reads.length === 0,
    `tabs ${context.pages().length}/${tabsBefore}`,
  );
  // The job's page open in a tab: read there.
  const jobTab = await context.newPage();
  await jobTab.goto(JOB_URL);
  await panel.bringToFront();
  await panel.locator("#import-url").fill(JOB_URL);
  await panel.locator("#import-form").getByRole("button", { name: "Add" }).click();
  const addIt = panel.getByRole("button", { name: "Add to Job Ops" });
  await addIt.waitFor({ timeout: 45_000 });
  check(
    "the open page read in the browser, Job Ops' reading shown to check",
    reads[0]?.url === JOB_URL &&
      reads[0].content.includes("Page Title: Platform Engineer - Acme") &&
      reads[0].content.includes("Run our Kubernetes platform") &&
      !reads[0].content.includes("Home Jobs") &&
      (await panel.getByLabel("Job title").inputValue()) === "Platform Engineer",
    JSON.stringify(reads[0]?.content.slice(0, 120)),
  );
  await addIt.click();
  await panel.getByText("added to Job Ops", { exact: false }).waitFor({ timeout: 15_000 });
  check(
    "added to Job Ops with its link as the application",
    imports[0]?.title === "Platform Engineer" &&
      imports[0].employer === "Acme" &&
      imports[0].jobUrl === JOB_URL &&
      imports[0].applicationLink === JOB_URL &&
      imports[0].jobDescription.includes("Kubernetes"),
    JSON.stringify(imports[0])?.slice(0, 200),
  );

  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ")}`);
  for (const e of trail.filter((e) => /failed|error/.test(e.kind)))
    console.log(`Trail: ${e.kind} ${e.message}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
