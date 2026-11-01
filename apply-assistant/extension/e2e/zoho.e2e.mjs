// A Zoho Recruit careers form (as The ePlane Company's): labels tied to fields only by an id
// made from the field's name ("crc-label-rec-form_…"), or sitting in the field's row; a "Search
// and add skills" box that makes a chip on Enter; a field that won't take the planned answer
// (it gets stuck: Claude reads the page closely, and the page is planned again from there);
// "Claude reads the page" with a screenshot; "Fix a field" from the list and from the page.
// Stub server; nothing real.
//   npx tsx e2e/zoho.e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const SERVER_HOST = "apply.hueint.com";
const FORM_URL = `https://${SERVER_HOST}/test/jobs/Careers/2111`;

// Zoho's label sits far from its input (lyte-input nests it deep), tied only by id.
const deep = (inner) => `<div><div><div><div><div><div><div>${inner}</div></div></div></div></div></div></div>`;
const named = (n, label) =>
  `<div class="crc-form-row"><label class="crc-form-from-label" id="crc-label-rec-form_${n}">${label}</label>${deep(`<input type="text" name="rec-form_${n}">`)}</div>`;

const FORM = String.raw`<!doctype html><html><head><title>Zoho Recruit</title></head><body>
<h1>Full Stack Product Engineer</h1>
<form onsubmit="return false">
${named(1, "First Name *")}
${named(2, "Street")}
${named(3, "Country")}
<div class="crc-form-row"><div><span class="crc-label-text">City</span></div>${deep('<input type="text" id="inputId" class="city">')}</div>
<div class="crc-form-row"><label for="addSkills">Skills</label><div id="chips"></div>
  <input type="text" id="addSkills" name="-add-skills" placeholder="Search and add skills"></div>
${named(4, "Notice Period (in days)")}
</form>
<script>
// Skills: Enter makes a chip and empties the box.
const skills = document.getElementById("addSkills");
skills.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !skills.value.trim()) return;
  e.preventDefault();
  document.getElementById("chips").insertAdjacentHTML("beforeend",
    '<span class="chip">' + skills.value.trim() + '<button aria-label="Remove skill">x</button></span>');
  skills.value = "";
});
// Notice period takes digits only: anything else is wiped.
const notice = document.querySelector("[name=rec-form_4]");
notice.addEventListener("input", () => {
  if (!/^\d*$/.test(notice.value)) setTimeout(() => { notice.value = ""; }, 0);
});
</script></body></html>`;

const posted = [];
const operateAsks = [];
const ok = (route, data) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });

/** As the server plans it, by label; after Claude's closer read, the notice period in days. */
function plan(page) {
  const closely = typeof page.snapshot === "string";
  const values = {
    "First Name": "Testy",
    Street: "12 Home Street",
    Country: "India",
    City: "Chennai",
    Skills: "Node.js, Docker, Redis",
    "Notice Period (in days)": closely ? "30" : "30 days",
  };
  return {
    add: [],
    entries: page.fields.map((f) => {
      const value = values[f.label.replace(/\s*\*$/, "")] ?? null;
      return {
        ref: f.ref,
        label: f.label,
        section: "main",
        type: f.kind === "file" ? "file" : "text",
        required: false,
        actionClass: "auto",
        status: value === null ? "skip" : "fill",
        value,
        optionValues: null,
        source: "bank:stub",
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
      { jobId: "stub", title: "Full Stack Product Engineer", employer: "ePlane", score: 90, jobUrl: FORM_URL, applicationLink: null, target: { status: "none" }, plan: null },
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

const profile = mkdtempSync(path.join(tmpdir(), "copilot-zoho-"));
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
const until = async (test, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
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
  await panel.locator("#queue li", { hasText: "Full Stack" }).first().waitFor();

  const form = await context.newPage();
  await form.goto(FORM_URL);
  await panel.bringToFront();
  await panel.locator("#here").getByRole("button", { name: "Fill this page" }).click();
  const reviewed = () =>
    panel
      .getByText("Check this page, then continue or submit it there yourself", { exact: false })
      .waitFor({ timeout: 90_000 });
  await reviewed();

  const value = (selector) => form.locator(selector).inputValue();
  const labels = posted[0]?.fields.map((f) => f.label) ?? [];
  check(
    "labels tied by the field's name, or in its row, are read (not rec-form_…)",
    ["First Name", "Street", "Country", "City"].every((l) => labels.includes(l)) &&
      !labels.some((l) => /^rec-form_/.test(l)),
    labels.join(" | "),
  );
  const chips = await form.locator(".chip").allInnerTexts();
  check(
    "a \"Search and add skills\" box gets one skill at a time, each with Enter",
    JSON.stringify(chips.map((c) => c.replace(/x$/, "").trim())) === '["Node.js","Docker","Redis"]',
    JSON.stringify(chips),
  );
  const closer = posted.find((p) => typeof p.snapshot === "string");
  check(
    "a stuck field: Claude reads the page's HTML (fields marked, nothing you typed), planned again",
    Boolean(closer) &&
      closer.snapshot.includes('data-aa-field="0"') &&
      !closer.snapshot.includes("Testy") &&
      !("screenshot" in closer) &&
      (await value("[name=rec-form_4]")) === "30",
    `${posted.length} plans; notice ${await value("[name=rec-form_4]")}`,
  );
  check(
    "the fields before the stuck one are left as they were",
    (await value("[name=rec-form_1]")) === "Testy" && (await value("[name=rec-form_2]")) === "12 Home Street",
  );

  // Fix a field from the list: Claude, told what's wrong.
  await panel.locator("details.fix-field summary").click();
  const pick = async (text) =>
    panel.locator("details.fix-field select").evaluate((select, wanted) => {
      const option = [...select.options].find((o) => o.textContent.endsWith(wanted));
      select.value = option?.value ?? "";
    }, text);
  await pick("Street");
  await panel.getByLabel("What's wrong with it").fill("should be 12 Main Road");
  await panel.getByRole("button", { name: "Claude fixes it" }).click();
  const told = await until(() =>
    operateAsks.some((a) => /Street/.test(a.label) && /should be 12 Main Road/.test(a.failure ?? "")),
  );
  check(
    "Fix a field with Claude: Claude works that field, told what you said",
    told,
    JSON.stringify(operateAsks.map((a) => [a.label, a.failure])),
  );
  // Claude (stubbed) finds the field showing an answer, and the page is checked again.
  await reviewed();

  // Fix a field you clicked on the page: filled again, alone.
  const before = posted.length;
  await form.bringToFront();
  await form.locator("input.city").fill("Wrong");
  await form.locator("input.city").click();
  await panel.bringToFront();
  await panel.locator("details.fix-field").evaluate((d) => {
    d.open = true;
  });
  await pick("The field I clicked on the page");
  await panel.getByRole("button", { name: "Fill it again" }).click();
  const refilled = await until(async () => (await value("input.city")) === "Chennai");
  check(
    "Fix a field: the one you clicked on the page is filled again, nothing else",
    refilled && posted.length === before + 1 && (await value("[name=rec-form_2]")) === "12 Home Street",
    `city ${await value("input.city")}, ${posted.length - before} plan(s)`,
  );
  await reviewed();

  // "Claude reads the page" (you asked): its HTML and a screenshot.
  const asked = posted.length;
  await panel.locator("select[aria-label^='Fill again']").selectOption("closely:");
  const read = await until(() => posted.length > asked && typeof posted.at(-1)?.snapshot === "string");
  const last = posted.at(-1);
  check(
    "Claude reads the page when you ask: the form's HTML and a screenshot",
    read && typeof last?.screenshot === "string" && last.screenshot.length > 1_000,
    `${posted.length - asked} plan(s), screenshot ${last?.screenshot?.length ?? 0} chars`,
  );
  await reviewed();
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ").slice(0, 1500)}`);
  console.log(`Plans: ${posted.map((p) => `${p.snapshot ? "[closely] " : ""}${p.fields.map((f) => f.label).join("|")}`).join(" ;; ")}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
