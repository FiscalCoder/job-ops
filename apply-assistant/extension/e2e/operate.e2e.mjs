// "Let Claude do it" through the built extension, on a FAKE company page: a dropdown that
// opens only from its chevron, so the fill and Claude's HTML steps both fail. You press
// "Let Claude do it"; a stub server plays Claude's turns (scripted tool calls, as the computer
// toolset and the element tool send them). Clicks on Submit or another field and a ctrl+w are
// refused; opening the list by ref and clicking the option by pixel set it; what worked is
// saved as the site's steps. Nothing real is contacted, and no real Claude is called.
//   node e2e/operate.e2e.mjs
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
<style>.field{margin:16px 0} [role=listbox]{position:absolute;background:#fff;border:1px solid #888;list-style:none;margin:0;padding:4px}
[role=option]{padding:6px 10px;cursor:pointer} .pc{display:inline-block;min-width:160px;border:1px solid #888;padding:4px}</style></head><body>
<h1>Apply for Senior Engineer</h1>
<form id="form" onsubmit="return false">
  <div class="field"><label for="fn">First name *</label><input id="fn" name="first_name"></div>
  <div class="field"><label id="pc-label">Preferred contact</label>
    <div class="pc" role="combobox" aria-labelledby="pc-label" tabindex="0">Choose…</div>
    <button type="button" class="pc-open" aria-label="Open choices">▾</button></div>
  <button type="submit" id="submit">Submit application</button>
</form>
<script>
const $ = (s) => document.querySelector(s);
window.submitClicks = 0;
$("#submit").addEventListener("click", () => { window.submitClicks++; });
// Only the chevron opens the list (at the end of the page); Escape closes it.
const close = () => document.querySelectorAll("[role=listbox]").forEach((l) => l.remove());
$(".pc-open").addEventListener("click", () => {
  close();
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Contact choices");
  const r = $(".pc").getBoundingClientRect();
  list.style.left = r.left + scrollX + "px";
  list.style.top = r.bottom + scrollY + 4 + "px";
  for (const label of ["Email", "Phone", "Post"]) {
    const li = document.createElement("li");
    li.textContent = label;
    li.tabIndex = 0;
    li.addEventListener("click", () => { $(".pc").textContent = label; close(); });
    list.append(li);
  }
  document.body.append(list);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
</script></body></html>`;

const VALUES = { "First name": "Testy", "Preferred contact": "Email" };

/** Elements of an outline (operate-page.ts): ref, role, name and the box's centre. */
function parseOutline(text) {
  return [...String(text).matchAll(/^(e\d+) (\S+) "([^"]*)".*box=\[(-?\d+),(-?\d+),(\d+),(\d+)\]$/gm)].map(
    (m) => ({
      ref: m[1],
      role: m[2],
      name: m[3],
      centre: [Number(m[4]) + Math.round(Number(m[6]) / 2), Number(m[5]) + Math.round(Number(m[7]) / 2)],
    }),
  );
}

const posted = [];
const operateBodies = [];
const stops = [];
const recipeResults = [];
const trail = [];
/** Set before the run: where Submit and First name are (CSS pixels; screenshots are 1:1 here). */
const at = { submit: null, firstName: null };
const ok = (route, data) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
const turn = (calls, done = false, why = "") => ({ session: "11111111-1111-4111-8111-111111111111", calls, done, why, cost: 0.04 });
const computer = (id, name, input) => ({ id, name, toolset: "computer", input });

/** "Claude": one scripted turn per request, answering from the outline it was sent. */
function claudeTurn(body, index) {
  switch (index) {
    case 0:
      // Tries Submit (refused).
      return turn([computer("c1", "left_click", { coordinate: at.submit })]);
    case 1:
      // Tries another field, then a key that closes tabs (both refused; the 2nd isn't run).
      return turn([
        computer("c2", "left_click", { coordinate: at.firstName }),
        computer("c3", "key", { text: "ctrl+w" }),
      ]);
    case 2:
      return turn([computer("c4", "key", { text: "ctrl+w" })]);
    case 3: {
      const chevron = parseOutline(operateBodies[0].outline).find((e) => e.name === "Open choices");
      return turn([
        { id: "c5", name: "element", toolset: null, input: { ref: chevron?.ref, action: "click" } },
        computer("c6", "screenshot", {}),
      ]);
    }
    case 4: {
      const shot = body.results.find((r) => r.id === "c6");
      const email = parseOutline(shot?.text).find((e) => e.name === "Email");
      return turn([computer("c7", "left_click", { coordinate: email?.centre ?? [0, 0] })]);
    }
    default:
      return turn([], true, "It shows Email now.");
  }
}

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
        status: VALUES[f.label] ? "fill" : "skip",
        value: VALUES[f.label] ?? null,
        optionValues: null,
        source: "bank:stub",
      })),
    });
  }
  // Claude's HTML steps find nothing for this widget.
  if (url.pathname === "/plans/stub/act")
    return ok(route, { steps: [], why: "stub: can't from the HTML" });
  if (url.pathname === "/plans/stub/operate") {
    const body = req.postDataJSON();
    operateBodies.push(body);
    return ok(route, claudeTurn(body, operateBodies.length - 1));
  }
  if (url.pathname === "/plans/stub/operate/stop") {
    stops.push(req.postDataJSON());
    return ok(route, { stopped: true });
  }
  if (url.pathname.startsWith("/trace")) {
    try {
      trail.push(...(req.postDataJSON()?.events ?? []));
    } catch {}
    return ok(route, {});
  }
  if (url.pathname === "/recipes" && req.method() === "POST") {
    recipeResults.push(req.postDataJSON());
    return ok(route, {});
  }
  if (url.pathname === "/runs" && req.method() === "POST")
    return ok(route, { id: "stub-run" });
  if (url.pathname.startsWith("/runs/")) return ok(route, {});
  return ok(route, []);
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-operate-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  // Screenshots go out at most 1280×800: at this size they're 1:1 with the page.
  viewport: { width: 1280, height: 720 },
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
  const centre = (selector) =>
    form.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
    }, selector);
  at.submit = await centre("#submit");
  at.firstName = await centre("#fn");
  await panel.bringToFront();
  const fill = panel.locator("#here").getByRole("button", { name: "Fill this page" });
  await fill.waitFor({ timeout: 15_000 });
  await fill.click();

  const letClaude = panel.getByRole("button", { name: "Let Claude do it" });
  await letClaude.waitFor({ timeout: 90_000 });
  check("a field the fill and Claude's HTML steps couldn't set offers Let Claude do it", true);
  await letClaude.click();
  await panel
    .getByText("Check this page, then continue or submit it there yourself", { exact: false })
    .waitFor({ timeout: 60_000 });

  const [start, ...rest] = operateBodies;
  const outline = parseOutline(start?.outline);
  check(
    "Claude gets the field, its value, a screenshot and an outline of just the field's area",
    start?.label === "Preferred contact" &&
      start.wanted === "Email" &&
      start.screenshot?.mediaType === "image/jpeg" &&
      start.screenshot.data.length > 1000 &&
      outline.some((e) => e.role === "combobox" && e.name === "Preferred contact") &&
      outline.some((e) => e.name === "Open choices") &&
      !outline.some((e) => /First name|Submit/.test(e.name)),
    start?.outline,
  );
  const result = (id) => rest.flatMap((b) => b.results ?? []).find((r) => r.id === id);
  check(
    "a click on Submit is refused",
    result("c1")?.ok === false && /submits/.test(result("c1")?.text) &&
      (await form.evaluate(() => window.submitClicks)) === 0,
    JSON.stringify(result("c1")),
  );
  check(
    "a click on another field is refused; the next action in that turn isn't run",
    result("c2")?.ok === false && /outside this field/.test(result("c2")?.text) &&
      result("c3")?.text === "Not executed: an earlier computer action in this turn failed.",
    JSON.stringify([result("c2"), result("c3")]),
  );
  check(
    "a key that isn't allowed is refused (the tab stays open)",
    result("c4")?.ok === false && !form.isClosed(),
    JSON.stringify(result("c4")),
  );
  const shot = result("c6");
  check(
    "the element tool opened the list; the screenshot came back with a fresh outline listing it",
    result("c5")?.ok === true &&
      shot?.screenshot?.mediaType === "image/jpeg" &&
      /Open listbox "Contact choices"/.test(shot.text) &&
      parseOutline(shot.text).some((e) => e.name === "Email"),
    shot?.text,
  );
  const shown = await form.evaluate(() => ({
    contact: document.querySelector(".pc").textContent,
    first: document.querySelector("#fn").value,
    banner: !!document.getElementById("ac-operate-banner"),
  }));
  check(
    "a pixel click on the option set the field, read back as set",
    result("c7")?.ok === true && shown.contact === "Email",
    JSON.stringify({ c7: result("c7"), contact: shown.contact }),
  );
  check("the other field kept its value; the banner is gone", shown.first === "Testy" && !shown.banner);
  const saved = recipeResults.find((r) => r.label === "Preferred contact" && r.ok);
  check(
    "what worked saved as this site's steps, without your answer",
    JSON.stringify(saved?.steps) ===
      JSON.stringify([
        { action: "click", value: 'button[aria-label="Open choices"]' },
        { action: "pick", value: "{value}" },
      ]),
    JSON.stringify(recipeResults),
  );
  // The trail goes up in batches.
  for (let i = 0; i < 40 && !trail.some((e) => /set by Claude/.test(e.message)); i++)
    await new Promise((r) => setTimeout(r, 250));
  check(
    "your click on Let Claude do it and the result are in the trail",
    trail.some((e) => e.kind === "decision" && /asked Claude to work/.test(e.message)) &&
      trail.some((e) => e.kind === "step-filled" && /set by Claude/.test(e.message)),
    trail.filter((e) => /decision|step-/.test(e.kind)).map((e) => e.message).join(" | "),
  );
  check("no session left to stop (Claude finished)", stops.length === 0, JSON.stringify(stops));
  check("no side panel errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
  const shown = (await shownOnFailure?.().catch(() => "")) ?? "";
  console.log(`Side panel: ${shown.replace(/\s*\n\s*/g, " / ")}`);
  console.log(`Operate bodies: ${JSON.stringify(operateBodies.map((b) => ({ ...b, screenshot: undefined, results: b.results?.map((r) => ({ ...r, screenshot: !!r.screenshot })) })))}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
