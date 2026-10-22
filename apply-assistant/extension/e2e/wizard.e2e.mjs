// A company form in parts on one address (as on Virtusa): Next swaps the fields in place, with
// the same address and heading. The run notices the swap, plans the new part and fills it; and
// "Fill this page" reads the page on screen again whenever you ask. Stub server; nothing real.
//   node e2e/wizard.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const SERVER_HOST = "apply.hueint.com";
const FORM_URL = `https://${SERVER_HOST}/test/careers/jobs/123/apply`;

const FORM = String.raw`<!doctype html><html><head><title>Acme Careers</title>
<style>.field{margin:12px 0}</style></head><body>
<h1>Apply for Senior Engineer</h1>
<ol class="steps"><li>Personal Information</li><li>Additional Information</li></ol>
<form id="form" onsubmit="return false"><div id="part"></div>
  <button type="button" id="prev">Prev</button><button type="button" id="next">Next</button></form>
<script>
const $ = (s) => document.querySelector(s);
const PARTS = [
  '<div class="field"><label for="fn">First Name *</label><input id="fn"></div>' +
  '<div class="field"><label for="ln">Last Name *</label><input id="ln"></div>',
  '<div class="field"><label for="city">City *</label><input id="city"></div>' +
  '<div class="field"><label for="prev-emp">Have you been employed with Acme previously? *</label>' +
  '<select id="prev-emp"><option value="">Please Select</option><option>Yes</option><option>No</option></select></div>',
];
let at = 0;
const show = () => { $("#part").innerHTML = PARTS[at]; };
$("#next").addEventListener("click", () => { at = Math.min(at + 1, PARTS.length - 1); show(); });
$("#prev").addEventListener("click", () => { at = Math.max(at - 1, 0); show(); });
show();
</script></body></html>`;

const VALUES = {
  "First Name": "Testy",
  "Last Name": "User",
  City: "Chennai",
  "Have you been employed with Acme previously?": "No",
};

const posted = [];
const trail = [];
const ok = (route, data) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });

function stubServer(route, url) {
  const req = route.request();
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
        type: f.kind === "text" ? "text" : "select",
        required: f.required,
        actionClass: "auto",
        status: VALUES[f.label.replace(/\s*\*$/, "")] ? "fill" : "skip",
        value: VALUES[f.label.replace(/\s*\*$/, "")] ?? null,
        optionValues: null,
        source: "bank:stub",
      })),
    });
  }
  if (url.pathname.startsWith("/trace")) {
    try {
      trail.push(...(req.postDataJSON()?.events ?? []));
    } catch {}
    return ok(route, {});
  }
  if (url.pathname === "/runs" && req.method() === "POST")
    return ok(route, { id: "stub-run" });
  if (url.pathname.startsWith("/runs/")) return ok(route, {});
  return ok(route, []);
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-wizard-"));
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
const labels = (page) => page?.fields.map((f) => f.label.replace(/\s*\*$/, "")).join("|");

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
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).click();
  const done = () =>
    panel
      .getByText("Check this page, then continue or submit it there yourself", { exact: false })
      .waitFor({ timeout: 60_000 });
  await done();
  check(
    "part 1 planned and filled",
    labels(posted[0]) === "First Name|Last Name" &&
      (await form.evaluate(() => document.querySelector("#fn").value)) === "Testy",
    labels(posted[0]),
  );

  // You click Next: same address, same heading, new fields.
  await form.locator("#next").click();
  for (let i = 0; i < 60 && posted.length < 2; i++) await new Promise((r) => setTimeout(r, 250));
  await done();
  const part2 = await form.evaluate(() => ({
    city: document.querySelector("#city").value,
    before: document.querySelector("#prev-emp").value,
  }));
  check(
    "the part Next swapped in is noticed, planned and filled",
    labels(posted[1]) === "City|Have you been employed with Acme previously?" &&
      part2.city === "Chennai" &&
      part2.before === "No",
    `${labels(posted[1])} · ${JSON.stringify(part2)}`,
  );

  // "Fill this page" reads the page on screen again and fills it.
  await form.evaluate(() => {
    document.querySelector("#city").value = "";
  });
  const refill = panel.locator("#run-box").getByRole("button", { name: "Fill this page" });
  await refill.click();
  for (let i = 0; i < 60 && posted.length < 3; i++) await new Promise((r) => setTimeout(r, 250));
  await done();
  check(
    "Fill this page beside Pause and Abort reads the page again and fills it",
    posted.length === 3 &&
      (await form.evaluate(() => document.querySelector("#city").value)) === "Chennai",
    `${posted.length} plans`,
  );
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ")}`);
  console.log(`Plans: ${posted.map(labels).join(" ; ")}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
