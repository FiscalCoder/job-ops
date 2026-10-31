// A company form inside an iframe (as on iCIMS) that asks you to sign in first: the sign-in
// sends the whole tab to another site (LinkedIn) and back, to the application in a new iframe.
// The run notices the new page (or you press "Fill this page") and fills it. iCIMS's hidden
// "Please Enable Cookies" message isn't a problem on the page.
// Stub server; nothing real.
//   node e2e/signin.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const SERVER_HOST = "apply.hueint.com";
const SSO_HOST = "sso.example";
const LOGIN_URL = `https://${SERVER_HOST}/test/careers/jobs/123/login`;
const CANDIDATE_URL = `https://${SERVER_HOST}/test/careers/jobs/123/candidate`;

/** The outer page: the form's iframe. */
const outer = (inner) => `<!doctype html><html><head><title>Careers</title></head><body>
<iframe id="icims_content_iframe" src="${inner}" style="width:900px;height:600px"></iframe>
</body></html>`;

/** In every iCIMS page, hidden unless cookies are off. */
const NO_COOKIES = `<style>.iCIMS_NoCookies{display:none}</style>
<div class="iCIMS_ErrorMsg iCIMS_ErrorMessage iCIMS_NoCookies">
<div class="iCIMS_ErrorMsgTitle">Please Enable Cookies to Continue</div>
Please enable cookies in your browser.</div>`;

const LOGIN = `<!doctype html><html><head><title>Login</title></head><body>
${NO_COOKIES}
<h1>Enter Your Information</h1>
<label for="email">Email</label><input type="email" id="email">
<button type="button" id="linkedin"
  onclick="window.top.location.href='https://${SSO_HOST}/auth'">Log in with LinkedIn</button>
</body></html>`;

const SSO = `<!doctype html><html><head><title>LinkedIn</title></head><body>
<p>Signing you in…</p>
<script>setTimeout(() => location.replace("${CANDIDATE_URL}"), 800);</script>
</body></html>`;

const CANDIDATE = `<!doctype html><html><head><title>Candidate</title></head><body>
${NO_COOKIES}
<h1>Candidate Profile</h1>
<label for="fn">First Name</label><input id="fn">
<label for="city">City</label><input id="city">
<div id="exp"><fieldset id="x1"><legend>Professional Experience (1)</legend>
<label for="e1">Employer</label><input id="e1" value="EduFund"></fieldset></div>
<a role="button" href="#" id="add-exp">Add More (Professional Experience)</a>
<script>
document.querySelector("#add-exp").addEventListener("click", (e) => {
  e.preventDefault();
  const n = String(document.querySelectorAll("#exp fieldset").length + 1);
  setTimeout(() => document.querySelector("#exp").insertAdjacentHTML("beforeend",
    '<fieldset id="x' + n + '"><legend>Professional Experience (' + n + ')</legend>' +
    '<label for="e' + n + '">Employer</label><input id="e' + n + '"></fieldset>'), 300);
});
</script>
</body></html>`;

const VALUES = { Email: "testy@example.com", "First Name": "Testy", City: "Chennai" };
/** The job the site's saved profile is missing: it goes in the block added for it. */
const CURRENT_JOB = "Athenahealth";
const jobBlocks = (page) =>
  new Set(page.fields.filter((f) => f.block?.heading?.startsWith("Professional")).map((f) => f.block.id)).size;

const posted = [];
const ok = (route, data) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
const html = (route, body) =>
  route.fulfill({ status: 200, contentType: "text/html", body });

function stubServer(route, url) {
  const req = route.request();
  const inner = url.searchParams.has("in_iframe");
  if (url.pathname.endsWith("/login"))
    return html(route, inner ? LOGIN : outer(`${LOGIN_URL}?in_iframe=1`));
  if (url.pathname.endsWith("/candidate"))
    return html(route, inner ? CANDIDATE : outer(`${CANDIDATE_URL}?in_iframe=1`));
  if (url.pathname === "/queue")
    return ok(route, [
      {
        jobId: "stub",
        title: "Backend Engineer",
        employer: "Acme",
        score: 80,
        jobUrl: LOGIN_URL,
        applicationLink: null,
        target: { status: "none" },
        plan: null,
      },
    ]);
  if (url.pathname === "/plans/stub/page") {
    const page = req.postDataJSON();
    posted.push(page);
    return ok(route, {
      schemaHash: "x",
      jobCountry: null,
      summary: {},
      // Two jobs on the resume: one block more than the page has.
      add:
        jobBlocks(page) === 1
          ? [{ section: "Professional Experience", count: 1 }]
          : [],
      entries: page.fields.map((f) => ({
        ref: f.ref,
        label: f.label,
        section: "main",
        type: "text",
        required: f.required,
        actionClass: "auto",
        status: VALUES[f.label] || (f.label === "Employer" && !f.value) ? "fill" : "skip",
        value: VALUES[f.label] ?? (f.label === "Employer" && !f.value ? CURRENT_JOB : null),
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

const profile = mkdtempSync(path.join(tmpdir(), "copilot-signin-"));
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
const wait = async (until, ms) => {
  for (let i = 0; i < ms / 250 && !until(); i++)
    await new Promise((r) => setTimeout(r, 250));
};
const inner = (page) => page.frameLocator("#icims_content_iframe");

try {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host === SERVER_HOST) return stubServer(route, url);
    if (url.host === SSO_HOST) return html(route, SSO);
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
  await panel.locator("#queue li", { hasText: "Backend Engineer" }).first().waitFor();

  const form = await context.newPage();
  await form.goto(LOGIN_URL);
  await inner(form).locator("#email").waitFor();
  await panel.bringToFront();
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).click();
  const done = () =>
    panel
      .getByText("Check this page, then continue or submit it there yourself", { exact: false })
      .waitFor({ timeout: 60_000 });
  await done();
  check(
    "the sign-in page in the iframe is filled",
    (await inner(form).locator("#email").inputValue()) === VALUES.Email,
  );
  check(
    "iCIMS's hidden cookie message isn't shown as a problem",
    !(await panel.locator("#run-box").innerText()).includes("Enable Cookies"),
  );

  // Signing in sends the whole tab to LinkedIn and back, to the form in a new iframe.
  await inner(form).locator("#linkedin").click();
  await form.waitForURL(CANDIDATE_URL, { timeout: 15_000 });
  await inner(form).locator("#fn").waitFor();
  // The candidate page is planned, a job block added, and planned again.
  await wait(() => posted.length >= 3, 30_000);
  const noticed = posted.length >= 3;
  if (!noticed)
    await panel.locator("#run-box").getByRole("button", { name: "Fill this page" }).click();
  await wait(() => posted.length >= 3, 30_000);
  await done();
  await new Promise((r) => setTimeout(r, 1_000));
  const filled = {
    fn: await inner(form).locator("#fn").inputValue(),
    city: await inner(form).locator("#city").inputValue(),
    jobs: await inner(form).locator("#exp input").evaluateAll((l) => l.map((i) => i.value)),
  };
  check(
    "after signing in, the application in the new iframe is planned and filled",
    posted.length >= 3 && filled.fn === "Testy" && filled.city === "Chennai",
    `${posted.length} plans · ${JSON.stringify(filled)}`,
  );
  check(
    "a job missing from the site's saved profile gets a block from Add More, filled; the others kept",
    JSON.stringify(filled.jobs) === JSON.stringify(["EduFund", CURRENT_JOB]) &&
      jobBlocks(posted[1]) === 1 &&
      jobBlocks(posted[2]) === 2,
    JSON.stringify(filled.jobs),
  );
  check("the new page was noticed without pressing Fill this page", noticed);

  // "Fill this page" still reads the page on screen.
  await inner(form).locator("#city").fill("");
  await panel.locator("#run-box").getByRole("button", { name: "Fill this page" }).click();
  await wait(() => posted.length >= 4, 20_000);
  await done();
  check(
    "Fill this page fills the page on screen again",
    posted.length >= 4 && (await inner(form).locator("#city").inputValue()) === "Chennai",
    `${posted.length} plans`,
  );
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ")}`);
  console.log(`Plans: ${posted.map((p) => p.fields.map((f) => f.label).join("|")).join(" ; ")}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
