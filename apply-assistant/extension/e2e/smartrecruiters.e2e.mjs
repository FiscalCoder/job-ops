// A SmartRecruiters one-click form (as Renesas's, 2026-11-03): its fields live inside web
// components (<spl-input>, <spl-textarea>, <spl-dropzone>) whose inputs sit in open shadow
// roots, and a profile photo upload sits outside them. The reader finds the shadowed fields
// and fills them; an upload you tell Claude is wrong is emptied and left alone; and "Tell
// Claude" sends your words with the page's HTML (the components' insides written in) and a
// screenshot. Stub server; nothing real.
//   npx tsx e2e/smartrecruiters.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url));
const SERVER_HOST = "apply.hueint.com";
const FORM_URL = `https://${SERVER_HOST}/test/oneclick-ui/company/Acme/publication/1`;

const FORM = String.raw`<!doctype html><html><head><title>SmartRecruiters</title></head><body>
<h1>Software Development Engineer - Backend</h1>
<form onsubmit="return false">
  <div class="avatar"><label for="avatar">Upload profile image</label><input type="file" id="avatar" name="file-upload-avatar"></div>
  <spl-input id="first-name-input" data-label="First name"></spl-input>
  <spl-input id="last-name-input" data-label="Last name"></spl-input>
  <spl-input id="email-input" type="email" data-label="Email"></spl-input>
  <h3>Resume *</h3>
  <spl-dropzone data-test="resume-upload"></spl-dropzone>
  <spl-textarea id="message" data-label="Message to the Hiring Team"></spl-textarea>
  <spl-autocomplete id="city" data-label="City"></spl-autocomplete>
  <spl-phone-field id="phone"></spl-phone-field>
  <spl-chips id="work-model" data-label="Work model"></spl-chips>
  <spl-editor id="cover"></spl-editor>
  <section data-test="experience"><h3>Experience</h3>
    <spl-button data-label="Add experience entry"><span>Add</span></spl-button>
    <div class="entry"><p>Lead Engineer · Acme Corp · 2021 - Present</p><spl-button data-label="Edit experience Lead Engineer Acme Corp"></spl-button></div>
    <div data-test="experience-edit-form" id="entry-form"><label for="jt">Job title</label><input id="jt"><spl-button id="entry-save" data-label="Save"></spl-button></div>
  </section>
  <button type="button" id="more-q" aria-expanded="false">Additional questions</button>
  <div id="more" hidden><label for="notice">Notice period (days)</label><input id="notice"></div>
  <button type="submit" id="submit-app" onclick="window.__submitted = true">Submit application</button>
</form>
<script>
// Each component keeps its label and input in its own (open) shadow root, as Angular's spl-* do.
class SplInput extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<label for="i">' + this.getAttribute("data-label") + '</label><input id="i" type="' + (this.getAttribute("type") || "text") + '">';
  }
}
class SplTextarea extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<label for="t">' + this.getAttribute("data-label") + '</label><textarea id="t"></textarea>';
  }
}
class SplDropzone extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<div class="zone">Choose a file or drop it here</div><input type="file" style="display:none">';
  }
}
// Suggestions open inside the component, in a fixed-position list (offsetParent is null there).
class SplAutocomplete extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<label for="c">' + this.getAttribute("data-label") + '</label><input id="c" role="combobox" aria-autocomplete="list"><ul role="listbox" style="position:fixed;top:0;left:0;background:#fff"></ul>';
    const input = root.getElementById("c");
    const list = root.querySelector("ul");
    input.addEventListener("input", () => {
      list.innerHTML = "";
      if (input.value.length < 2) return;
      for (const place of ["Chennai, Tamil Nadu", "Chennai Port, Tamil Nadu", "Bengaluru, Karnataka"])
        if (place.toLowerCase().includes(input.value.toLowerCase())) {
          const li = document.createElement("li");
          li.setAttribute("role", "option");
          li.textContent = place;
          li.addEventListener("click", () => { input.value = place; list.innerHTML = ""; });
          list.append(li);
        }
    });
  }
}
// The phone's country code lists dialling codes only ("+91"), as SmartRecruiters' does.
class SplPhoneField extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<label for="cc">Country code</label><select id="cc"><option value="">Select</option><option>+93</option><option>+91</option><option>+1</option></select><label for="ph">Phone number</label><input id="ph" type="tel">';
  }
}
// Typing does nothing: only its buttons set it (what Claude's steps are for).
class SplChips extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<div class="chips"><label for="w">' + this.getAttribute("data-label") + '</label><input id="w"><button type="button" data-v="Onsite">Onsite</button><button type="button" data-v="Remote">Remote</button></div>';
    const input = root.getElementById("w");
    let chosen = "";
    input.addEventListener("input", () => { input.value = chosen; });
    for (const b of root.querySelectorAll("button"))
      b.addEventListener("click", () => { chosen = b.dataset.v; input.value = chosen; });
  }
}
// A formatted text editor: no input at all, so the reader never sees it; Claude's read does.
class SplEditor extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<div id="cover-note" contenteditable="true" aria-label="Cover note" style="min-height:40px;border:1px solid #ccc"></div>';
  }
}
// Icon buttons: the button and its name are inside the component.
class SplButton extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<button type="button" aria-label="' + this.getAttribute("data-label") + '"><slot></slot></button>';
  }
}
customElements.define("spl-button", SplButton);
// The entry's own Save: the job becomes a card.
document.getElementById("entry-save").shadowRoot.querySelector("button").addEventListener("click", () => {
  const title = document.getElementById("jt").value;
  document.getElementById("entry-form").outerHTML = '<div class="entry" id="saved-entry"><p>' + title + '</p></div>';
});
// A closed section: its question shows once it's opened.
document.getElementById("more-q").addEventListener("click", (e) => {
  e.currentTarget.setAttribute("aria-expanded", "true");
  document.getElementById("more").hidden = false;
});
customElements.define("spl-autocomplete", SplAutocomplete);
customElements.define("spl-phone-field", SplPhoneField);
customElements.define("spl-chips", SplChips);
customElements.define("spl-editor", SplEditor);
customElements.define("spl-input", SplInput);
customElements.define("spl-textarea", SplTextarea);
customElements.define("spl-dropzone", SplDropzone);
</script></body></html>`;

const posted = [];
const acted = [];
const traced = [];
const ok = (route, data) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });

/** As the old server planned it: every upload gets the resume, until you tell Claude otherwise. */
function plan(page) {
  const told = typeof page.note === "string";
  const values = {
    "First name": "Testy",
    "Last name": "User",
    Email: "test@example.com",
    "Message to the Hiring Team": "I'd love to build your backend.",
    City: "Chennai",
    "Country code": "India",
    "Phone number": "9876543210",
    "Work model": "Remote",
    "Notice period (days)": "30",
    "Job title": "Staff Engineer",
  };
  // Claude's read alongside the fill (the page's HTML, no words of yours): it finds the editor.
  const early = typeof page.snapshot === "string" && !told;
  // As the server: closed sections are opened first (once; the extension never clicks twice).
  const reveal = (page.revealers ?? []).filter((r) => r.collapsed).map((r) => r.ref);
  return {
    add: [],
    ...(reveal.length ? { reveal } : {}),
    entries: page.fields.map((f) => {
      const file = f.kind === "file";
      const photo = /profile image/i.test(f.label);
      const value = file ? (told && photo ? null : "Tailored resume (PDF from Job Ops)") : (values[f.label] ?? null);
      return {
        ref: f.ref,
        label: f.label,
        section: "main",
        type: file ? "file" : f.kind === "textarea" ? "textarea" : "text",
        required: false,
        actionClass: "auto",
        status: value === null ? "skip" : "fill",
        value,
        optionValues: null,
        source: file ? "jobops:tailored-pdf" : "bank:stub",
      };
    }).concat(
      early
        ? [{ ref: "spl-editor#cover >>> #cover-note", label: "Cover note", section: "main", type: "textarea", required: false, actionClass: "auto", status: "fill", value: "Hello from Claude's read", optionValues: null, source: "claude:stub" }]
        : [],
    ),
  };
}

function stubServer(route, url) {
  const req = route.request();
  if (url.pathname.startsWith("/test/"))
    return route.fulfill({ status: 200, contentType: "text/html", body: FORM });
  if (url.pathname === "/queue")
    return ok(route, [
      { jobId: "stub", title: "Software Development Engineer - Backend", employer: "Acme", score: 90, jobUrl: FORM_URL, applicationLink: null, target: { status: "none" }, plan: null },
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
    return ok(route, plan(page));
  }
  if (url.pathname === "/trace/events") traced.push(...(req.postDataJSON()?.events ?? []));
  if (url.pathname === "/plans/stub/act") {
    const ask = req.postDataJSON();
    acted.push(ask);
    return ok(route, {
      steps: ask.label === "Work model" ? [{ action: "click", value: "button[data-v='{value}']" }] : [],
      why: "its buttons set it",
    });
  }
  if (url.pathname === "/runs" && req.method() === "POST") return ok(route, { id: "stub-run" });
  return ok(route, req.method() === "GET" ? [] : {});
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-smartrecruiters-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});
const failures = [];
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures.push(name);
};
const until = async (test, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
let panel = null;

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
  panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.locator("#queue li", { hasText: "Software Development" }).first().waitFor();

  const form = await context.newPage();
  await form.goto(FORM_URL);
  await panel.bringToFront();
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).click();
  const reviewed = () =>
    panel.getByText("Check this page, then continue or submit it there yourself", { exact: false }).waitFor({ timeout: 60_000 });
  await reviewed();

  const shadowValue = (selector) =>
    form.evaluate((s) => {
      const host = document.querySelector(s);
      const field = host?.shadowRoot?.querySelector("input, textarea");
      return field?.value ?? null;
    }, selector);
  const files = () =>
    form.evaluate(() => ({
      avatar: document.getElementById("avatar").files.length,
      resume: document.querySelector("spl-dropzone").shadowRoot.querySelector("input").files[0]?.name ?? null,
    }));

  const labels = posted[0]?.fields.map((f) => f.label) ?? [];
  check(
    "fields inside web components are read, with the labels in their shadow roots",
    ["First name", "Last name", "Email", "Message to the Hiring Team"].every((l) => labels.includes(l)),
    labels.join(" | "),
  );
  check(
    "they're filled where they are (inside the components)",
    (await shadowValue("#first-name-input")) === "Testy" &&
      (await shadowValue("#email-input")) === "test@example.com" &&
      (await shadowValue("#message")) === "I'd love to build your backend.",
    JSON.stringify([await shadowValue("#first-name-input"), await shadowValue("#message")]),
  );
  check("the resume reaches the dropzone inside its component", (await files()).resume === "Resume.pdf", JSON.stringify(await files()));

  const shadow = (host, inner) =>
    form.evaluate(([h, i]) => {
      const el = document.querySelector(h)?.shadowRoot?.querySelector(i);
      return el ? (el.isContentEditable ? el.textContent : el.value) : null;
    }, [host, inner]);
  check(
    "an autocomplete whose suggestions open inside its component: the suggestion is picked",
    await until(async () => (await shadow("#city", "input")) === "Chennai, Tamil Nadu"),
    String(await shadow("#city", "input")),
  );
  check(
    "a country-code list of dialling codes takes your country (India: +91); the number goes in",
    (await until(async () => (await shadow("#phone", "select")) === "+91")) &&
      (await shadow("#phone", "input")) === "9876543210",
    JSON.stringify([await shadow("#phone", "select"), await shadow("#phone", "input")]),
  );
  check(
    "Claude's steps click inside the component (only its buttons set it)",
    (await until(async () => (await shadow("#work-model", "input")) === "Remote")) &&
      acted.some((a) => a.label === "Work model" && /data-ac-target/.test(a.html)),
    `${String(await shadow("#work-model", "input"))}; asked ${acted.length}`,
  );
  check(
    "Claude reads the page alongside the fill (HTML and a screenshot, no words of yours) and the editor the reader missed is filled",
    posted.some((p) => typeof p.snapshot === "string" && typeof p.screenshot === "string" && p.note === undefined) &&
      (await until(async () => (await shadow("#cover", "#cover-note")) === "Hello from Claude's read")),
    `${String(await shadow("#cover", "#cover-note"))}; plans: ${posted.map((p) => (p.snapshot ? (p.note ? "told" : "read") : "plain")).join(",")}; ${traced.filter((e) => /Cover note|Claude's read|reads page/.test(e.message)).map((e) => e.message).join(" | ").slice(0, 900)}`,
  );
  const firstPage = posted[0] ?? {};
  check(
    "a job the page shows as a card (with its Edit inside a component) is sent as filled, not as fields",
    (firstPage.cards ?? []).some((c) => /Acme Corp/.test(c.text) && /Experience/.test(c.heading)) &&
      !(firstPage.cards ?? []).some((c) => /Additional questions/.test(c.text)),
    JSON.stringify(firstPage.cards ?? []).slice(0, 300),
  );
  check(
    "a closed section is opened, the page planned again and its hidden question filled",
    (await until(async () => (await form.evaluate(() => document.getElementById("notice").value)) === "30")) &&
      posted.some((p) => p.fields.some((f) => f.label === "Notice period (days)")),
    String(await form.evaluate(() => document.getElementById("notice").value)),
  );
  await reviewed();
  check(
    "a job form opened on the page is saved with its own Save once filled; the application is never submitted",
    (await until(async () => (await form.evaluate(() => document.getElementById("saved-entry")?.textContent ?? "")) === "Staff Engineer")) &&
      !(await form.evaluate(() => window.__submitted === true)),
    String(await form.evaluate(() => document.getElementById("saved-entry")?.textContent ?? "(not saved)")),
  );

  // The old plan put the resume in the profile photo too: you tell Claude it's wrong there.
  check("(as before the fix) the profile photo got the resume too", (await files()).avatar === 1);
  await panel.locator("details.fix-field summary").click();
  await panel.locator("details.fix-field select").evaluate((select) => {
    const option = [...select.options].find((o) => o.textContent.endsWith("Upload profile image"));
    select.value = option?.value ?? "";
  });
  await panel.getByLabel("What's wrong with it").fill("that's my profile photo, not the resume");
  await panel.getByRole("button", { name: "Claude fixes it" }).click();
  check(
    "Fix a field on an upload: emptied and left out of this page, not filled again",
    (await until(async () => (await files()).avatar === 0)) &&
      (await until(
        async () =>
          (await panel.getByText("won't fill it again on this page", { exact: false }).count()) > 0,
        10_000,
      )),
    JSON.stringify(await files()),
  );

  // Tell Claude what to do on this page: your words, the page's HTML (shadow roots written in)
  // and a screenshot; then the page is filled again.
  const before = posted.length;
  await panel.locator("details.tell-claude summary").click();
  await panel.getByLabel("Tell Claude what to do on this page").fill(
    "the resume goes in the Resume box, not the profile photo",
  );
  await panel.getByRole("button", { name: "Tell Claude and refill" }).click();
  const told = await until(() => posted.length > before && typeof posted.at(-1)?.note === "string");
  const last = posted.at(-1);
  check(
    "Tell Claude: your words go with the page's HTML (the components' fields in it) and a screenshot",
    told &&
      last.note === "the resume goes in the Resume box, not the profile photo" &&
      /data-aa-field/.test(last.snapshot ?? "") &&
      /Message to the Hiring Team/.test(last.snapshot ?? "") &&
      /<shadow-root>/.test(last.snapshot ?? "") &&
      typeof last.screenshot === "string",
    `${posted.length - before} plan(s); note ${JSON.stringify(last?.note)}`,
  );
  await reviewed();
  check("after it, the profile photo stays empty; the resume stays in its box", (await files()).avatar === 0 && (await files()).resume === "Resume.pdf", JSON.stringify(await files()));
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await panel?.locator("body").innerText().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ").slice(0, 1500)}`);
  console.log(`Plans: ${posted.map((p) => `${p.note ? "[told] " : ""}${p.fields.map((f) => `${f.label}(${f.kind})`).join("|")}`).join(" ;; ")}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
