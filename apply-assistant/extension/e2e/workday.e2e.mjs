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
// Only the pop-up lists: a search field's picked tags are a listbox too.
const closeLists = () => document.querySelectorAll("[role=listbox][data-popup]").forEach((l) => l.remove());
function openList(anchor, labels, onPick) {
  closeLists();
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  list.setAttribute("data-popup", "");
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
  '<div data-automation-id="multiSelectContainer"><ul role="listbox" data-automation-id="selectedItemList"></ul><div data-automation-id="multiselectInputContainer"><input id="source--source" placeholder="Search"></div></div></div>' +
  '<fieldset class="field" data-automation-id="formField-candidateIsPreviousWorker" data-fkit-id="previousWorker--candidateIsPreviousWorker"><legend><label><span>Have you worked for Acme?<abbr>*</abbr></span></label></legend>' +
  '<input id="pw1" name="pw" type="radio" value="true"><label for="pw1">Yes</label><input id="pw2" name="pw" type="radio" value="false"><label for="pw2">No</label></fieldset>' +
  '<div class="field" data-automation-id="formField-country" data-fkit-id="country--country"><label for="country--country"><span>Country<abbr>*</abbr></span></label>' +
  '<button aria-haspopup="listbox" type="button" id="country--country" aria-label="Country Select One Required">Select One</button><input type="text" hidden></div>' +
  '<div class="field" data-automation-id="formField-contactMethod" data-fkit-id="contact--contactMethod"><label for="contact--contactMethod"><span>Preferred Contact Method<abbr>*</abbr></span></label>' +
  '<button aria-haspopup="listbox" type="button" id="contact--contactMethod">Select One</button><span class="chevron" role="button" aria-label="Open list">v</span></div>' +
  '<div class="field" data-automation-id="formField-legalName--firstName" data-fkit-id="name--legalName--firstName"><label for="name--legalName--firstName"><span>Given Name(s)<abbr>*</abbr></span></label>' +
  '<input id="name--legalName--firstName" aria-required="true"></div>' +
  '<div class="field" data-automation-id="formField-acceptTermsAndAgreements" data-fkit-id="termsAndConditions--acceptTermsAndAgreements"><label for="terms">I consent to the terms<abbr>*</abbr></label>' +
  '<input type="checkbox" id="terms"></div>';
// My Experience as on Walmart (Apply Manually): Work Experience and Education start empty with
// an Add button, Skills is a search, and the Resume/CV upload is a field of its own (its
// container's data-automation-id is just "formField-"); "Successfully Uploaded!" once attached.
const myExperience = '<h2>My Experience</h2>' +
  '<div role="group" aria-labelledby="Work-Experience-section"><h4 id="Work-Experience-section">Work Experience</h4><div id="we-list"></div><button type="button" data-automation-id="add-button" id="we-add">Add</button></div>' +
  '<div role="group" aria-labelledby="Education-section"><h4 id="Education-section">Education</h4><div id="ed-list"></div><button type="button" data-automation-id="add-button" id="ed-add">Add</button></div>' +
  '<div role="group" aria-labelledby="Skills-section"><h4 id="Skills-section">Skills</h4>' +
  '<div class="field" data-automation-id="formField-skills" data-fkit-id="skills--skills"><label for="skills--skills">Type to Add Skills</label>' +
  '<div data-automation-id="multiSelectContainer"><ul role="listbox" data-automation-id="selectedItemList"></ul><input id="skills--skills" placeholder="Search"></div></div></div>' +
  '<div class="field" data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments"><label><span>Upload a file (5MB max)<abbr>*</abbr></span></label>' +
  '<div data-automation-id="file-upload-drop-zone"><button type="button" data-automation-id="select-files" id="resumeAttachments--attachments">Select files</button>' +
  '<input data-automation-id="file-upload-input-ref" type="file" style="display:none"></div><div id="uploaded"></div></div>';
const field = (id, key, label, control) =>
  '<div class="field" data-automation-id="formField-' + key + '" data-fkit-id="' + id + '--' + key + '"><label for="' + id + '--' + key + '"><span>' + label + '</span></label>' + control + '</div>';
const text = (id, key, label) => field(id, key, label + '<abbr>*</abbr>', '<input id="' + id + '--' + key + '">');
// A date: month and year spin buttons, each showing what was typed. As on Workday, the inputs
// have no size: clicking the "MM" / "YYYY" shown focuses them.
const date = (id, key, label) =>
  '<div class="field" data-automation-id="formField-' + key + '" data-fkit-id="' + id + '--' + key + '"><fieldset><legend><label>' + label + '<abbr>*</abbr></label></legend>' +
  '<div data-automation-id="dateInputWrapper"><div data-automation-id="dateSectionMonth-display">MM</div><input role="spinbutton" style="width:0;height:0;padding:0;border:0" data-automation-id="dateSectionMonth-input">/' +
  '<div data-automation-id="dateSectionYear-display">YYYY</div><input role="spinbutton" style="width:0;height:0;padding:0;border:0" data-automation-id="dateSectionYear-input"></div></fieldset></div>';
const search = (id, key, label) => field(id, key, label + '<abbr>*</abbr>',
  '<div data-automation-id="multiSelectContainer"><ul role="listbox" data-automation-id="selectedItemList"></ul><input id="' + id + '--' + key + '" placeholder="Search"></div>');
let nextId = 200;
function addJob() {
  const n = $("#we-list").children.length + 1, id = "workExperience-" + nextId++;
  $("#we-list").insertAdjacentHTML("beforeend", '<div role="group" aria-labelledby="Work-Experience-' + n + '-panel"><h5 id="Work-Experience-' + n + '-panel">Work Experience ' + n + '</h5>' +
    text(id, "jobTitle", "Job Title") + text(id, "companyName", "Company") +
    field(id, "currentlyWorkHere", "I currently work here", '<input type="checkbox" id="' + id + '--currentlyWorkHere">') +
    date(id, "startDate", "From") + date(id, "endDate", "To") +
    field(id, "roleDescription", "Role Description<abbr>*</abbr>", '<textarea id="' + id + '--roleDescription"></textarea>') + '</div>');
}
function addDegree() {
  const n = $("#ed-list").children.length + 1, id = "education-" + nextId++;
  $("#ed-list").insertAdjacentHTML("beforeend", '<div role="group" aria-labelledby="Education-' + n + '-panel"><h5 id="Education-' + n + '-panel">Education ' + n + '</h5>' +
    search(id, "school", "School or University") + search(id, "fieldOfStudy", "Field of Study") +
    field(id, "degree", "Degree<abbr>*</abbr>", '<button aria-haspopup="listbox" type="button" id="' + id + '--degree">Select One</button><input type="text" hidden>') + '</div>');
}
// What each search field finds (by the end of its id).
const RESULTS = {
  source: ["LinkedIn", "LinkedIn Learning", "Indeed", "Referral"],
  school: ["Some Institute of Technology", "Some School"],
  fieldOfStudy: ["Computer Science", "Information Systems", "Management Studies"],
  skills: ["React", "React Native", "TypeScript"],
};
document.addEventListener("input", (e) => {
  const display = e.target.previousElementSibling;
  if (e.target.getAttribute("role") === "spinbutton" && display) display.textContent = e.target.value;
});
document.addEventListener("click", (e) => {
  // Clicking the "MM" / "YYYY" shown focuses its input.
  if (e.target.matches("[data-automation-id$='-display']")) e.target.nextElementSibling?.focus();
  if (e.target.id === "we-add") addJob();
  if (e.target.id === "ed-add") addDegree();
  // Preferred Contact Method opens only from its chevron.
  if (e.target.closest(".chevron")) {
    const button = e.target.closest(".field").querySelector("button");
    openList(button, ["Select One", "Email", "Phone"], (label) => { button.textContent = label; });
  }
  const degree = e.target.closest("[id$='--degree']");
  if (degree) openList(degree, ["Select One", "Diploma", "Bachelor's Degree"], (label) => { degree.textContent = label; });
});
document.addEventListener("keydown", (e) => {
  const input = e.target;
  // As on Workday, Ctrl+A doesn't select a search box's text.
  if (e.ctrlKey && e.key === "a" && input.closest?.("[data-automation-id=multiSelectContainer]")) e.preventDefault();
  if (e.key !== "Enter" || !input.closest?.("[data-automation-id=multiSelectContainer]")) return;
  const typed = input.value.toLowerCase();
  const found = RESULTS[input.id.split("--").pop()].filter((r) => r.toLowerCase().includes(typed));
  openList(input, found.length ? found : ["No Items."], (label) => {
    if (label === "No Items.") return;
    const pill = document.createElement("li");
    // As on Workday, a picked tag is an option of a listbox ("selectedItemList").
    pill.setAttribute("role", "option");
    pill.setAttribute("data-automation-id", "selectedItem");
    pill.textContent = label;
    input.closest("[data-automation-id=multiSelectContainer]").querySelector("[data-automation-id=selectedItemList]").append(pill);
    input.value = "";
  });
});
const review = '<h2>Review</h2><p>Check your application.</p><button id="submit">Submit</button>';
const STEPS = ["My Information", "My Experience", "Review"];
const PAGES = { "My Information": () => myInformation, "My Experience": () => myExperience, Review: () => review };
// Workday shows the next step's name first and swaps the fields in a moment later.
const SWAP_MS = 3000;
function show(step, swapMs = 0) {
  $("#step").textContent = "current step " + (STEPS.indexOf(step) + 1) + " of 3 " + step;
  if (swapMs) return setTimeout(() => fill(step), swapMs);
  fill(step);
}
function fill(step) {
  $("#page").innerHTML = PAGES[step]();
  $("#next").hidden = step === "Review";
  if (step === "My Experience") {
    const input = $("[data-automation-id=file-upload-input-ref]");
    input.addEventListener("change", () => {
      window.uploaded = [...input.files].map((f) => f.name + ":" + f.size);
      $("#uploaded").innerHTML = '<div data-automation-id="file-upload-successful">Successfully Uploaded!</div>';
    });
    return;
  }
  if (step === "Review") {
    $("#submit").addEventListener("click", () => { document.body.innerHTML = "<h1>Application Submitted</h1><p>Your application has been submitted.</p>"; });
    return;
  }
  const country = $("#country--country");
  country.addEventListener("click", () => {
    window.opened.push("country");
    // Workday's Country list is ~250 long.
    const others = Array.from({ length: 248 }, (_, i) => "Country " + i);
    openList(country, ["Select One", "India", "United States of America", ...others], (label) => { country.textContent = label; });
  });
}
$("#next").addEventListener("click", () => {
  const at = STEPS.indexOf($("#step").textContent.replace(/^current step \d+ of \d+ /, ""));
  show(STEPS[at + 1], STEPS[at + 1] === "Review" ? 0 : SWAP_MS);
});
show("My Information");
</script></body></html>`;

const VALUES = {
  source: "LinkedIn",
  candidateIsPreviousWorker: "No",
  country: "India",
  contactMethod: "Email",
  "legalName--firstName": "Testy",
  acceptTermsAndAgreements: "I consent to the terms",
};

// My Experience, from the resume: the n-th entry on the page gets the n-th job / degree.
const JOBS = [
  { jobTitle: "Senior Engineer", companyName: "Acme", currentlyWorkHere: "I currently work here", startDate: "09/2023", roleDescription: "Built the platform." },
  { jobTitle: "Engineer", companyName: "Beta", startDate: "01/2020", endDate: "08/2023", roleDescription: "Built features." },
];
// "Information System Management" isn't in the list as such: Claude picks the closest.
const DEGREES = [{ school: "Some Institute of Technology", fieldOfStudy: "Information System Management", degree: "Bachelor's Degree" }];
/** The stub's answer for one field (the server maps entries the same way). */
function valueFor(field, order) {
  const entry = /^(workExperience|education)-(\d+)--/.exec(field.ref);
  if (entry) {
    const list = entry[1] === "workExperience" ? JOBS : DEGREES;
    const index = order.filter((o) => o.startsWith(entry[1])).indexOf(entry[0]);
    return list[index]?.[field.key] ?? null;
  }
  // Kafka isn't in Workday's list: the skills the list has are enough, and its text mustn't be
  // left for the next one to be typed onto.
  if (field.key === "skills") return ["React", "Kafka", "TypeScript"];
  return VALUES[field.key] ?? null;
}

const posted = [];
const chooseAsks = [];
const actAsks = [];
const recipeCalls = [];
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
    const order = [
      ...new Set(
        page.fields
          .map((f) => /^(workExperience|education)-\d+--/.exec(f.ref)?.[0])
          .filter(Boolean),
      ),
    ];
    const add = (page.sections ?? []).flatMap((s) => {
      const wanted = { "Work-Experience-section": JOBS.length, "Education-section": DEGREES.length }[s.id] ?? 0;
      return wanted > s.entries ? [{ section: s.id, count: wanted - s.entries }] : [];
    });
    return ok(route, {
      schemaHash: "x",
      jobCountry: null,
      summary: {},
      add,
      entries: page.fields.map((f) =>
        f.kind === "file"
          ? {
              ref: f.ref,
              label: f.label,
              section: "main",
              type: "file",
              required: true,
              actionClass: "auto",
              status: "fill",
              value: "Tailored resume (PDF from Job Ops)",
              optionValues: null,
              source: "jobops:tailored-pdf",
            }
          : {
              ref: f.ref,
              label: f.label,
              section: "main",
              type: f.key === "skills" ? "multiselect" : ["text", "date", "textarea"].includes(f.kind) ? "text" : "select",
              required: f.required,
              actionClass: "auto",
              status: valueFor(f, order) ? "fill" : "skip",
              value: valueFor(f, order),
              optionValues: null,
              source: "bank:stub",
            },
      ),
    });
  }
  if (url.pathname === "/plans/stub/choose") {
    const ask = req.postDataJSON();
    chooseAsks.push(ask);
    return ok(route, {
      value: ask.options.includes("Information Systems") ? "Information Systems" : ask.options[0],
      why: "stub",
    });
  }
  // "Claude": open the list from its chevron, then pick the value.
  if (url.pathname === "/plans/stub/act") {
    const ask = req.postDataJSON();
    actAsks.push(ask);
    return ok(route, {
      steps: [
        { action: "click", value: ".chevron" },
        { action: "pick", value: ask.wanted },
      ],
      why: "stub",
    });
  }
  if (url.pathname === "/recipes") {
    recipeCalls.push(
      req.method() === "GET" ? { host: url.searchParams.get("host") } : req.postDataJSON(),
    );
    return ok(route, req.method() === "GET" ? [] : {});
  }
  if (url.pathname === "/kit/stub")
    return ok(route, {
      job: {
        jobId: "stub",
        title: "Engineer",
        employer: "Acme",
        location: null,
        applyUrl: APPLY_PAGE,
        tailoredSummary: null,
      },
      groups: [],
    });
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
let shownOnFailure = null;
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
  shownOnFailure = () => panel.locator("body").innerText();
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
  // The Apply kit (which opened the application) starts it too.
  await panel.locator("#here").getByRole("button", { name: "Apply kit" }).click();
  const kitFill = panel
    .locator("#kit-box")
    .getByRole("button", { name: "Fill this page" });
  await kitFill.waitFor({ timeout: 15_000 });
  check("Fill this page offered in the Apply kit", true);
  await kitFill.click();

  await panel
    .getByText('Check "My Information" on the page', { exact: false })
    .waitFor({ timeout: 60_000 });
  const first = posted[0];
  check("page 1 planned", first?.step === "My Information", first?.step);
  const country = first?.fields.find((f) => f.key === "country");
  check(
    "all 250 dropdown choices read by opening it",
    country?.options.length === 250 &&
      country.options[0] === "India" &&
      !country.options.includes("Select One"),
    `${country?.options.length} choices`,
  );
  check(
    "header menu not read as a field",
    !first?.fields.some((f) => /utility/i.test(f.ref)),
  );
  const shown = await form.evaluate(() => ({
    country: document.querySelector("#country--country")?.textContent,
    contact: document.querySelector("#contact--contactMethod")?.textContent,
    source: [...document.querySelectorAll("[data-automation-id=selectedItem]")]
      .map((p) => p.textContent)
      .join(","),
    worked: document.querySelector("#pw2")?.checked,
    name: document.querySelector("#name--legalName--firstName")?.value,
    terms: document.querySelector("#terms")?.checked,
    listsOpen: document.querySelectorAll("[role=listbox][data-popup]").length,
  }));
  check("dropdown filled", shown.country === "India", shown.country);
  check(
    "a dropdown the driver couldn't open filled with Claude's steps from its HTML",
    shown.contact === "Email" &&
      actAsks.length === 1 &&
      actAsks[0].label.startsWith("Preferred Contact Method") &&
      actAsks[0].html.includes('data-ac-target="1"'),
    `${shown.contact}; ${actAsks.length} asks`,
  );
  const saved = recipeCalls.find((c) => c.label);
  check(
    "steps that worked saved for every Workday site, without your answer",
    recipeCalls[0]?.host === "myworkdayjobs.com" &&
      saved?.host === "myworkdayjobs.com" &&
      saved.ok === true &&
      JSON.stringify(saved.steps) ===
        JSON.stringify([
          { action: "click", value: ".chevron" },
          { action: "pick", value: "{value}" },
        ]),
    JSON.stringify(recipeCalls),
  );
  check("search picked once", shown.source === "LinkedIn", shown.source);
  check("radio chosen", shown.worked === true);
  check("text typed", shown.name === "Testy", shown.name);
  check("terms ticked", shown.terms === true);
  check("no list left open", shown.listsOpen === 0);

  // You check the page and continue; the run follows to the next page, which Workday swaps in
  // a few seconds after showing its name.
  await form.locator("#next").click();
  await panel
    .getByText('Reading "My Experience" and planning it', { exact: false })
    .waitFor({ timeout: 10_000 });
  check("you're told the next page is being read", true);
  await panel
    .getByText('Check "My Experience" on the page', { exact: false })
    .waitFor({ timeout: 60_000 });
  const second = posted[1];
  check(
    "next page read only once its fields were swapped in",
    second?.step === "My Experience" &&
      second.fields.some((f) => f.ref === "resumeAttachments--attachments") &&
      !second.fields.some((f) => f.key === "legalName--firstName"),
    JSON.stringify(second?.fields.map((f) => f.ref)),
  );
  check(
    "empty sections reported, then planned again once entries were added",
    JSON.stringify(second?.sections.map((s) => [s.id, s.entries])) ===
      JSON.stringify([["Work-Experience-section", 0], ["Education-section", 0]]) &&
      posted[2]?.sections.map((s) => s.entries).join() === "2,1",
    JSON.stringify(posted.slice(1).map((p) => p.sections)),
  );
  const experience = await form.evaluate(() => {
    const shown = (panel, key) =>
      [...panel.querySelectorAll(`[data-fkit-id$="--${key}"] [data-automation-id$="-display"]`)]
        .map((d) => d.textContent)
        .join("/");
    const jobs = [...document.querySelectorAll("#we-list > [role=group]")].map((panel) => ({
      title: panel.querySelector("[id$='--jobTitle']").value,
      company: panel.querySelector("[id$='--companyName']").value,
      current: panel.querySelector("[id$='--currentlyWorkHere']").checked,
      from: shown(panel, "startDate"),
      to: shown(panel, "endDate"),
      description: panel.querySelector("textarea").value,
    }));
    const pills = (s) =>
      [...document.querySelectorAll(`${s} [data-automation-id=selectedItem]`)].map((p) => p.textContent).join(",");
    return {
      jobs,
      school: pills("#ed-list [data-fkit-id$='--school']"),
      study: pills("#ed-list [data-fkit-id$='--fieldOfStudy']"),
      degree: document.querySelector("#ed-list [id$='--degree']")?.textContent,
      skills: pills("[data-fkit-id='skills--skills']"),
      uploaded: window.uploaded,
    };
  });
  check(
    "a work experience entry added and filled per job",
    JSON.stringify(experience.jobs) ===
      JSON.stringify([
        { title: "Senior Engineer", company: "Acme", current: true, from: "09/2023", to: "MM/YYYY", description: "Built the platform." },
        { title: "Engineer", company: "Beta", current: false, from: "01/2020", to: "08/2023", description: "Built features." },
      ]),
    JSON.stringify(experience.jobs),
  );
  check(
    "an education entry added and filled",
    experience.school === "Some Institute of Technology" &&
      experience.study === "Information Systems" &&
      experience.degree === "Bachelor's Degree",
    `${experience.school} / ${experience.study} / ${experience.degree}`,
  );
  check(
    "Field of Study not in the list as such: Claude picked from what its words found",
    chooseAsks.length === 1 &&
      chooseAsks[0].wanted === "Information System Management" &&
      chooseAsks[0].options.includes("Information Systems") &&
      chooseAsks[0].options.includes("Management Studies") &&
      !chooseAsks[0].options.includes("No Items."),
    JSON.stringify(chooseAsks),
  );
  check(
    "skills added one by one (those Workday has)",
    experience.skills === "React,TypeScript",
    experience.skills,
  );
  check(
    "resume attached to the page's own upload field",
    experience.uploaded?.[0]?.startsWith("Resume.pdf:"),
    JSON.stringify(experience.uploaded),
  );
  await form.locator("#next").click();
  await panel
    .getByText("Review the form on the page, then click Submit yourself")
    .waitFor({ timeout: 30_000 });
  check(
    "Review page not planned (nothing to fill)",
    posted.length === 3,
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
  check("every filled step logged", steps === 21, `${steps} logged`);
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  // What the side panel showed: usually says which step stopped and why.
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ")}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
