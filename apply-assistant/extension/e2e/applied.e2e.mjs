// A company's one-page form (as on arbeitnow) with a long address and heading: after you submit,
// the form is hidden in place and the heading says "Applied today"; a newsletter box stays.
// The run sees the application was sent instead of planning the page again and again.
// Stub server; nothing real.
//   node e2e/applied.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const SERVER_HOST = "apply.hueint.com";
const FORM_URL = `https://${SERVER_HOST}/test/jobs/companies/it-studio-rech-gmbh/senior-full-stack-developer-schwerpunkt-typescript-saas-plattform-berlin-229612`;

const FORM = String.raw`<!doctype html><html><head><title>Arbeitnow</title></head><body>
<h1 id="title">Senior Full-Stack Developer (m/w/d) – Schwerpunkt TypeScript &amp; SaaS-Plattform</h1>
<form id="apply" onsubmit="return false">
  <label for="first_name">First name</label><input id="first_name">
  <label for="email">Email address</label><input id="email" type="email">
  <button type="button" id="send">Apply</button>
</form>
<footer><label>Newsletter <input type="email" name="emailAddress" placeholder="Enter your email"></label></footer>
<script>
document.querySelector("#send").addEventListener("click", () => {
  document.querySelector("#apply").style.display = "none";
  document.querySelector("#title").insertAdjacentHTML("beforeend", " <span>Applied today</span>");
});
</script></body></html>`;

const VALUES = { "First name": "Testy", "Email address": "testy@example.com" };

const posted = [];
const refused = [];
const ok = (route, data) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });

function stubServer(route, url) {
  const req = route.request();
  if (url.pathname.startsWith("/test/"))
    return route.fulfill({ status: 200, contentType: "text/html", body: FORM });
  if (url.pathname === "/queue")
    return ok(route, [
      {
        jobId: "stub",
        title: "Senior Full-Stack Developer",
        employer: "IT Studio Rech",
        score: 95,
        jobUrl: FORM_URL,
        applicationLink: null,
        target: { status: "none" },
        plan: null,
      },
    ]);
  if (url.pathname === "/plans/stub/page") {
    const page = req.postDataJSON();
    posted.push(page);
    // As the real server: a step over 200 characters is refused.
    if (page.step.length > 200) {
      refused.push(page.step);
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { message: "The page's fields couldn't be read (step); reload the page and try again" },
        }),
      });
    }
    return ok(route, {
      schemaHash: "x",
      jobCountry: null,
      summary: {},
      add: [],
      entries: page.fields.map((f) => ({
        ref: f.ref,
        label: f.label,
        section: "main",
        type: "text",
        required: f.required,
        actionClass: "auto",
        status: VALUES[f.label] ? "fill" : "skip",
        value: VALUES[f.label] ?? null,
        optionValues: null,
        source: "bank:stub",
      })),
    });
  }
  if (url.pathname === "/runs" && req.method() === "POST")
    return ok(route, { id: "stub-run" });
  if (url.pathname.startsWith("/runs/") || url.pathname.startsWith("/trace"))
    return ok(route, {});
  return ok(route, []);
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-applied-"));
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
  await panel.locator("#queue li", { hasText: "Senior Full-Stack Developer" }).first().waitFor();

  const form = await context.newPage();
  await form.goto(FORM_URL);
  await panel.bringToFront();
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).click();
  await panel
    .getByText("Check this page, then continue or submit it there yourself", { exact: false })
    .waitFor({ timeout: 60_000 });
  check(
    "the form is planned and filled",
    (await form.locator("#first_name").inputValue()) === "Testy",
  );

  // You submit: the form is hidden in place, the heading says "Applied today".
  const before = posted.length;
  await form.locator("#send").click();
  await new Promise((r) => setTimeout(r, 12_000));
  const shown = await panel.locator("body").innerText();
  check(
    "after you submit, the page isn't planned again and again",
    posted.length - before <= 1,
    `${posted.length - before} plan(s) after submitting`,
  );
  check("no step was refused for its length", refused.length === 0, refused.join(" | "));
  check(
    "\"Applied today\" ends the run as submitted, not \"Couldn't plan\"",
    !shown.includes("Couldn't plan") &&
      !shown.includes("Check this page") &&
      /marked as applied/i.test(shown),
    shown.replace(/\s*\n\s*/g, " / ").slice(0, 400),
  );
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ")}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
