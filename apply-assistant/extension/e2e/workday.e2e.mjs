// A supervised Workday run through the built extension, on a FAKE Workday wizard that behaves
// like the recorded LPL pages (dropdowns that list their choices only while open, search fields
// that keep picks as tags, radios, a terms checkbox, then Review). The apply-assistant server is
// a stub that plans each page from the fields the extension sends. Nothing real is contacted.
//   node e2e/workday.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const SERVER_HOST = "apply.hueint.com";
const JOB_PAGE =
  "https://acme.wd1.myworkdayjobs.com/en-US/External/job/Remote/Engineer_R1";
const APPLY_PAGE = `${JOB_PAGE}/apply/applyManually`;

const WIZARD = String.raw`<!doctype html><html><head><title>Acme Careers</title>
<style>[role=listbox]{position:absolute;background:#fff;border:1px solid #888;list-style:none;margin:0;padding:4px}
[role=option]{padding:4px 8px;cursor:pointer} .field{margin:14px 0}</style></head><body>
<header data-automation-id="header"><button data-automation-id="utilityMenuButton" aria-haspopup="listbox">Settings</button></header>
<div data-automation-id="applyFlowPage"><ol data-automation-id="progressBar"><li data-automation-id="progressBarActiveStep" id="step"></li></ol>
<main id="page"></main>
<footer data-automation-id="pageFooter"><button data-automation-id="pageFooterNextButton" id="next">Save and Continue</button></footer></div>
<script>
const $ = (s, r = document) => r.querySelector(s);
const closeLists = () => document.querySelectorAll("[role=listbox]").forEach((l) => l.remove());
function openList(anchor, labels, onPick) {
  closeLists();
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  const r = anchor.getBoundingClientRect();
  list.style.left = r.left + scrollX + "px";
  list.style.top = r.bottom + scrollY + "px";
  for (const label of labels) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.innerHTML = "<div>" + label + "</div>";
    li.addEventListener("click", () => { closeLists(); onPick(label); });
    list.append(li);
  }
  document.body.append(list);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLists(); });
window.opened = [];
const myInformation = '<h2>My Information</h2>' +
  '<div class="field" data-automation-id="formField-source" data-fkit-id="source--source"><label><span>How Did You Hear About Us?<abbr>*</abbr></span></label>' +
  '<div data-automation-id="multiSelectContainer"><ul data-automation-id="selectedItemList"></ul><div data-automation-id="multiselectInputContainer"><input id="source--source" placeholder="Search"></div></div></div>' +
  '<fieldset class="field" data-automation-id="formField-candidateIsPreviousWorker" data-fkit-id="previousWorker--candidateIsPreviousWorker"><legend><label><span>Have you worked for Acme?<abbr>*</abbr></span></label></legend>' +
  '<input id="pw1" name="pw" type="radio" value="true"><label for="pw1">Yes</label><input id="pw2" name="pw" type="radio" value="false"><label for="pw2">No</label></fieldset>' +
  '<div class="field" data-automation-id="formField-country" data-fkit-id="country--country"><label for="country--country"><span>Country<abbr>*</abbr></span></label>' +
  '<button aria-haspopup="listbox" type="button" id="country--country" aria-label="Country Select One Required">Select One</button><input type="text" hidden></div>' +
  '<div class="field" data-automation-id="formField-legalName--firstName" data-fkit-id="name--legalName--firstName"><label for="name--legalName--firstName"><span>Given Name(s)<abbr>*</abbr></span></label>' +
  '<input id="name--legalName--firstName" aria-required="true"></div>' +
  '<div class="field" data-automation-id="formField-acceptTermsAndAgreements" data-fkit-id="termsAndConditions--acceptTermsAndAgreements"><label for="terms">I consent to the terms<abbr>*</abbr></label>' +
  '<input type="checkbox" id="terms"></div>';
const review = '<h2>Review</h2><p>Check your application.</p><button id="submit">Submit</button>';
function show(step) {
  $("#step").textContent = "current step " + (step === "Review" ? 3 : 2) + " of 3 " + step;
  $("#page").innerHTML = step === "Review" ? review : myInformation;
  $("#next").hidden = step === "Review";
  if (step === "Review") {
    $("#submit").addEventListener("click", () => { document.body.innerHTML = "<h1>Application Submitted</h1><p>Your application has been submitted.</p>"; });
    return;
  }
  const country = $("#country--country");
  country.addEventListener("click", () => {
    window.opened.push("country");
    openList(country, ["Select One", "India", "United States of America"], (label) => { country.textContent = label; });
  });
  const search = $("#source--source");
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const typed = search.value.toLowerCase();
    const results = ["LinkedIn", "LinkedIn Learning", "Indeed", "Referral"].filter((r) => r.toLowerCase().includes(typed));
    openList(search, results, (label) => {
      const pill = document.createElement("li");
      pill.setAttribute("data-automation-id", "selectedItem");
      pill.textContent = label;
      $("[data-automation-id=selectedItemList]").append(pill);
      search.value = "";
    });
  });
}
$("#next").addEventListener("click", () => show("Review"));
show("My Information");
</script></body></html>`;

const VALUES = {
  source: "LinkedIn",
  candidateIsPreviousWorker: "No",
  country: "India",
  "legalName--firstName": "Testy",
  acceptTermsAndAgreements: "I consent to the terms",
};

const posted = [];
const runCalls = [];
const ok = (route, data) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
function stubServer(route, url) {
  const req = route.request();
  if (url.pathname === "/queue")
    return ok(route, [
      {
        jobId: "stub",
        title: "Engineer",
        employer: "Acme",
        score: 80,
        jobUrl: JOB_PAGE,
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
      entries: page.fields.map((f) => ({
        ref: f.ref,
        label: f.label,
        section: "main",
        type: f.kind === "text" ? "text" : "select",
        required: f.required,
        actionClass: "auto",
        status: VALUES[f.key] ? "fill" : "skip",
        value: VALUES[f.key] ?? null,
        optionValues: null,
        source: "bank:stub",
      })),
    });
  }
  if (url.pathname === "/runs" && req.method() === "POST")
    return ok(route, { id: "stub-run" });
  if (url.pathname.startsWith("/runs/")) {
    runCalls.push(`${req.method()} ${url.pathname}`);
    return ok(route, {});
  }
  return ok(route, []);
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-wd-"));
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
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures.push(name);
};

try {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host === SERVER_HOST) return stubServer(route, url);
    if (url.href.startsWith(APPLY_PAGE))
      return route.fulfill({ status: 200, contentType: "text/html", body: WIZARD });
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
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  await panel.locator("#queue li", { hasText: "Engineer" }).first().waitFor();

  const form = await context.newPage();
  await form.goto(APPLY_PAGE);
  await panel.bringToFront();
  const fill = panel.locator("#here").getByRole("button", {
    name: "Fill this page",
  });
  await fill.waitFor({ timeout: 15_000 });
  check("Fill this page offered on the Workday application", true);
  await fill.click();

  await panel
    .getByText('Check "My Information" on the page', { exact: false })
    .waitFor({ timeout: 60_000 });
  const first = posted[0];
  check("page 1 planned", first?.step === "My Information", first?.step);
  const country = first?.fields.find((f) => f.key === "country");
  check(
    "dropdown choices read by opening it",
    JSON.stringify(country?.options) ===
      JSON.stringify(["India", "United States of America"]),
    JSON.stringify(country?.options),
  );
  check(
    "header menu not read as a field",
    !first?.fields.some((f) => /utility/i.test(f.ref)),
  );
  const shown = await form.evaluate(() => ({
    country: document.querySelector("#country--country")?.textContent,
    source: [...document.querySelectorAll("[data-automation-id=selectedItem]")]
      .map((p) => p.textContent)
      .join(","),
    worked: document.querySelector("#pw2")?.checked,
    name: document.querySelector("#name--legalName--firstName")?.value,
    terms: document.querySelector("#terms")?.checked,
    listsOpen: document.querySelectorAll("[role=listbox]").length,
  }));
  check("dropdown filled", shown.country === "India", shown.country);
  check("search picked once", shown.source === "LinkedIn", shown.source);
  check("radio chosen", shown.worked === true);
  check("text typed", shown.name === "Testy", shown.name);
  check("terms ticked", shown.terms === true);
  check("no list left open", shown.listsOpen === 0);

  // You check the page and continue; the run follows to the next page.
  await form.locator("#next").click();
  await panel
    .getByText("Review the form on the page, then click Submit yourself")
    .waitFor({ timeout: 30_000 });
  check(
    "Review page not planned (nothing to fill)",
    posted.length === 1,
    `${posted.length} plans`,
  );

  await form.locator("#submit").click();
  await panel.getByText("Marked as applied", { exact: false }).waitFor({
    timeout: 30_000,
  });
  check(
    "run completed as submitted",
    runCalls.some((c) => c.startsWith("POST /runs/stub-run")),
    runCalls.join(" | "),
  );
  const steps = runCalls.filter((c) => c.includes("/actions")).length;
  check("every filled step logged", steps === 5, `${steps} logged`);
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
