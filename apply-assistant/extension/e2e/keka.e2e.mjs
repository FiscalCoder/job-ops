// A Keka careers form (as Zono's): job entries numbered under a plain "Experience Details"
// label, "+ Add Experience Details" links, read-only jQuery date pickers, a skills box that
// makes a tag on Enter, a number of days to join, and a captcha.
// Stub server; nothing real.
//   node e2e/keka.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const SERVER_HOST = "apply.hueint.com";
const FORM_URL = `https://${SERVER_HOST}/test/careers/applyjob/4314`;

const FORM = String.raw`<!doctype html><html><head><title>Keka</title></head><body>
<h1>SDE III, Backend</h1>
<form onsubmit="return false">
<div class="form-group"><label for="firstName">First Name</label><input id="firstName" name="firstName"></div>
<div class="form-group"><label for="email">Email</label><input id="email" type="email" name="email"></div>
<div class="form-group"><label for="availability">Available To Join (in days)</label><input id="availability" type="number" name="standardFields.availability.answer" value="-1"></div>
<div class="form-group col-sm-12"><label class="font-large" for="skills">Skills</label>
  <div class="d-flex" id="skills-box"><div id="skills-list"></div>
  <div><input type="text" placeholder="Add new skill" class="form-control" id="skills" value=""></div></div></div>
<div class="col-sm-12"><label class="font-large font-weight-bold"> Experience Details </label>
  <div id="experienceDetails"></div>
  <div><a class="kh-link" id="add-exp">+ Add Experience Details</a></div></div>
<div class="form-group"><label for="captcha">Captcha</label><input id="captcha" name="captcha"></div>
</form>
<script>
// A stand-in for jQuery UI's date picker: read-only boxes it writes into.
window.jQuery = (el) => ({
  datepicker(cmd, date) {
    if (cmd === "setDate") el.value = date.getDate() + " " + date.toLocaleString("en", { month: "long" }) + " " + date.getFullYear();
  },
  trigger() {},
});
const entry = (n) => '<div class="row" id="experienceDetails_' + n + '"><input type="hidden" name="ExperienceDetails[' + n + '].Identifier" value="x">' +
  '<div class="col-sm-6"><label for="companyName">Company Name</label><input type="text" name="ExperienceDetails[' + n + '].companyName" id="companyName_' + n + '"></div>' +
  '<div class="col-sm-6"><label for="designation">Job Title</label><input type="text" name="ExperienceDetails[' + n + '].designation" id="designation_' + n + '"></div>' +
  '<div><input type="checkbox" name="ExperienceDetails[' + n + '].isCurrentlyWorking" id="isCurrentlyWorking_' + n + '"><label for="isCurrentlyWorking_' + n + '">Currently working here</label></div>' +
  '<div><label for="dateOfJoining">Date of Joining</label><div class="input-calendar"><input type="text" readonly class="form-control hasDatepicker" id="experienceDateOfJoining_' + n + '" name="ExperienceDetails[' + n + '].dateOfJoining"></div></div>' +
  '</div>';
let count = 0;
const add = () => document.getElementById("experienceDetails").insertAdjacentHTML("beforeend", entry(count++));
add();
document.getElementById("add-exp").addEventListener("click", () => setTimeout(add, 200));
// Skills: Enter makes a tag (with its hidden input), and empties the box.
const skills = document.getElementById("skills");
let tags = 0;
skills.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !skills.value.trim()) return;
  e.preventDefault();
  const name = skills.value.trim();
  document.getElementById("skills-list").insertAdjacentHTML("beforeend",
    '<div class="tag" id="skill-' + tags + '"><span>' + name + '</span><input type="hidden" name="skills[' + tags + '].name" value="' + name + '"></div>');
  tags++;
  skills.value = "";
});
</script></body></html>`;

const COMPANIES = { "Experience Details-0": "Athenahealth", "Experience Details-1": "EduFund" };
const posted = [];
const operateAsks = [];
const ok = (route, data) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });

/** As the server plans it: job blocks, dates as YYYY-MM-01, days to join, skills as a list. */
function plan(page) {
  const jobs = new Set(page.fields.filter((f) => f.block?.heading === "Experience Details").map((f) => f.block.id));
  const planned = (f) => {
    const block = f.block?.id;
    if (f.label === "First Name") return { value: "Testy" };
    if (f.label === "Email") return { value: "testy@example.com" };
    if (f.label.startsWith("Available To Join")) return { value: "20" };
    if (f.label === "Skills") return { value: "Node.js, Docker, Redis" };
    if (f.label === "Company Name") return { value: COMPANIES[block] ?? null };
    if (f.label === "Job Title") return { value: block === "Experience Details-0" ? "Senior Member of Technical Staff" : "Product Engineer 2" };
    // As the planner gives a job's month.
    if (f.label === "Date of Joining") return { value: block === "Experience Details-0" ? "09/2025" : "10/2024" };
    if (f.label === "Currently working here")
      return block === "Experience Details-0" ? { value: "Currently working here", type: "select" } : { value: null, status: "skip" };
    if (f.label === "Captcha") return { value: null, status: "needs-you" };
    return { value: null, status: "skip" };
  };
  return {
    schemaHash: "keka",
    jobCountry: null,
    summary: {},
    add:
      jobs.size < 2 && (page.addable ?? []).includes("Experience Details")
        ? [{ section: "Experience Details", count: 2 - jobs.size }]
        : [],
    entries: page.fields.map((f) => {
      const p = planned(f);
      return {
        ref: f.ref,
        label: f.label,
        section: "main",
        type: p.type ?? "text",
        required: true,
        actionClass: "auto",
        status: p.status ?? (p.value === null ? "skip" : "fill"),
        value: p.value,
        optionValues: null,
        source: "bank:stub",
        ...(f.block ? { group: f.block.heading } : {}),
      };
    }),
  };
}

function stubServer(route, url) {
  const req = route.request();
  if (url.pathname.startsWith("/test/"))
    return route.fulfill({ status: 200, contentType: "text/html", body: FORM });
  if (url.pathname === "/queue")
    return ok(route, [
      { jobId: "stub", title: "SDE III, Backend", employer: "Zono", score: 90, jobUrl: FORM_URL, applicationLink: null, target: { status: "none" }, plan: null },
    ]);
  if (url.pathname === "/plans/stub/page") {
    const page = req.postDataJSON();
    posted.push(page);
    return ok(route, plan(page));
  }
  if (url.pathname === "/plans/stub/operate") {
    operateAsks.push(req.postDataJSON());
    return ok(route, { session: "11111111-1111-4111-8111-111111111111", calls: [], done: true, why: "stub", cost: 0.01 });
  }
  if (url.pathname === "/runs" && req.method() === "POST") return ok(route, { id: "stub-run" });
  if (url.pathname.startsWith("/runs/") || url.pathname.startsWith("/trace")) return ok(route, {});
  return ok(route, req.method() === "GET" ? [] : {});
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-keka-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
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
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() =>
    chrome.storage.local.set({ serverUrl: "https://apply.hueint.com", token: "stub", countdownSeconds: 1 }),
  );
  const panel = await context.newPage();
  shownOnFailure = () => panel.locator("body").innerText();
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.locator("#queue li", { hasText: "SDE III" }).first().waitFor();

  const form = await context.newPage();
  await form.goto(FORM_URL);
  await panel.bringToFront();
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).click();
  // The captcha waits for you (Claude never takes it): you skip it here.
  await panel.locator(".step-card", { hasText: "Captcha" }).waitFor({ timeout: 90_000 });
  await panel.getByRole("button", { name: "Skip" }).click();
  await panel
    .getByText("Check this page, then continue or submit it there yourself", { exact: false })
    .waitFor({ timeout: 60_000 });

  const shown = await form.evaluate(() => ({
    companies: [...document.querySelectorAll("[id^=companyName_]")].map((i) => i.value),
    titles: [...document.querySelectorAll("[id^=designation_]")].map((i) => i.value),
    current: [...document.querySelectorAll("[id^=isCurrentlyWorking_]")].map((i) => i.checked),
    joined: [...document.querySelectorAll("[id^=experienceDateOfJoining_]")].map((i) => i.value),
    skills: [...document.querySelectorAll("input[name^='skills[']")].map((i) => i.value),
    left: document.getElementById("skills").value,
    days: document.getElementById("availability").value,
  }));
  const first = posted[0];
  check(
    "job entries under a plain label heading are read as blocks; the page offers to add more",
    first?.fields.some((f) => f.block?.id === "Experience Details-0") &&
      (first?.addable ?? []).includes("Experience Details"),
    JSON.stringify({ blocks: [...new Set(first?.fields.map((f) => f.block?.id).filter(Boolean))], addable: first?.addable }),
  );
  check(
    "+ Add Experience Details adds the second job; each job its own company, title and box",
    JSON.stringify(shown.companies) === '["Athenahealth","EduFund"]' &&
      JSON.stringify(shown.titles) === '["Senior Member of Technical Staff","Product Engineer 2"]' &&
      JSON.stringify(shown.current) === "[true,false]",
    JSON.stringify(shown),
  );
  check(
    "read-only date pickers are set through the picker",
    JSON.stringify(shown.joined) === '["1 September 2025","1 October 2024"]',
    JSON.stringify(shown.joined),
  );
  check(
    "skills go in one at a time with Enter, each a tag",
    JSON.stringify(shown.skills) === '["Node.js","Docker","Redis"]' && shown.left === "",
    JSON.stringify({ skills: shown.skills, left: shown.left }),
  );
  check("days to join typed as a number", shown.days === "20", shown.days);
  check(
    "the captcha is never sent to Claude",
    !operateAsks.some((a) => /captcha/i.test(a.label ?? "")),
    `${operateAsks.length} Claude asks`,
  );
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ").slice(0, 1500)}`);
  console.log(`Plans: ${posted.map((p) => p.fields.map((f) => `${f.label}${f.block ? `[${f.block.id}]` : ""}`).join("|")).join(" ;; ")}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
