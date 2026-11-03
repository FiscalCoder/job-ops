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
customElements.define("spl-input", SplInput);
customElements.define("spl-textarea", SplTextarea);
customElements.define("spl-dropzone", SplDropzone);
</script></body></html>`;

const posted = [];
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
  };
  return {
    add: [],
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
    }),
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
