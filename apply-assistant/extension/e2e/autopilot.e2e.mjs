// Autopilot over the queue through the built extension, on FAKE careers sites (AUTOPILOT_PLAN.md):
// a closed posting (you're asked, then it's marked expired), a page with no Apply wording where
// "Claude" (a stub) picks the link, and an Apply button that opens the form in a new tab. Each
// form has an iCIMS-style dropdown that lists choices only after you type in its own search box.
// The apply-assistant server is a stub. Nothing real is contacted.
//   npm run build && node e2e/autopilot.e2e.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url));
const SERVER_HOST = "apply.hueint.com";

const JOBS = [
  // A dead link: the browser shows its own error page.
  { jobId: "gone", score: 95, jobUrl: "https://careers.gone.invalid/jobs/9" },
  // On a known system (Greenhouse): only checked for being closed, then its own run fills it.
  {
    jobId: "ghclosed",
    score: 92,
    jobUrl: "https://careers.closed.example:8443/jobs/7",
    target: { status: "matched", ats: "greenhouse", postingUrl: "https://boards.closed.example:8443/acme/jobs/7" },
  },
  { jobId: "closed", score: 90, jobUrl: "https://careers.closed.example:8443/jobs/1" },
  { jobId: "puzzle", score: 85, jobUrl: "https://careers.puzzle.example:8443/jobs/3" },
  // The same site again: its way to the form was learned on the job before.
  { jobId: "puzzle2", score: 84, jobUrl: "https://careers.puzzle.example:8443/jobs/4" },
  { jobId: "acme", score: 80, jobUrl: "https://careers.acme.example:8443/jobs/2" },
].map((j) => ({
  ...j,
  title: `Engineer ${j.jobId}`,
  employer: j.jobId,
  applicationLink: null,
  plan: null,
  target: j.target ?? { status: "none" },
}));

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const FORM = page(
  "Apply",
  String.raw`<h1>Apply</h1><form onsubmit="return false">
<p><label for="name">Full name</label><input id="name" name="name"></p>
<p><label for="email">Email</label><input id="email" type="email" name="email"></p>
<p><label for="phone">Phone</label><input id="phone" name="phone"></p>
<p><label for="consent">Atlassian leverages technologies such as ICIMS artificial intelligence features to automatically process Talent Data, including your CV</label><input id="consent" name="consent"></p>
<div><label id="st-label" for="st">State</label><select id="st" hidden><option></option></select>
<a id="st_dd" role="combobox" aria-labelledby="st-label" tabindex="0" style="display:inline-block;border:1px solid #888;padding:4px"><span id="st_text">— Make a Selection —</span></a>
<div id="st_ctnr" hidden><input class="dropdown-search" placeholder="— Type to Search —" role="combobox"><ul role="listbox" id="st_list"></ul></div></div>
<button type="submit">Submit application</button></form>
<script>
const states = ["Tamil Nadu", "Karnataka", "Kerala"];
const dd = document.getElementById("st_dd"), box = document.getElementById("st_ctnr");
const search = box.querySelector("input"), list = document.getElementById("st_list");
dd.addEventListener("click", () => { box.hidden = false; search.value = ""; list.innerHTML = ""; search.focus(); });
// Choices load only after typing, a moment later (as iCIMS's state list does).
search.addEventListener("input", () => setTimeout(() => {
  list.innerHTML = "";
  for (const s of states.filter((s) => search.value && s.toLowerCase().startsWith(search.value.toLowerCase()))) {
    const li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = s;
    li.addEventListener("click", () => { document.getElementById("st_text").textContent = s; box.hidden = true; });
    list.append(li);
  }
}, 300));
</script>`,
);

const SITES = {
  "https://boards.closed.example:8443/acme/jobs/7": page("Acme", "<h1>The job you are looking for is no longer open.</h1>"),
  "https://careers.closed.example:8443/jobs/1": page("Careers", "<h1>Sorry, this job is no longer available</h1>"),
  "https://careers.puzzle.example:8443/jobs/3": page(
    "Senior Engineer",
    `<h1>Senior Engineer</h1><p>Build things with us.</p><a href="https://careers.puzzle.example:8443/form/3">Join us →</a>`,
  ),
  "https://careers.puzzle.example:8443/form/3": FORM,
  "https://careers.puzzle.example:8443/jobs/4": page(
    "Staff Engineer",
    `<h1>Staff Engineer</h1><p>Lead things with us.</p><a href="https://careers.puzzle.example:8443/form/4">Join us →</a>`,
  ),
  "https://careers.puzzle.example:8443/form/4": FORM,
  "https://careers.acme.example:8443/jobs/2": page(
    "Engineer",
    `<h1>Engineer</h1><a href="https://www.linkedin.com/jobs/1">Apply with LinkedIn</a>
     <button onclick="window.open('https://careers.acme.example:8443/apply/2', '_blank')">Apply now</button>`,
  ),
  "https://careers.acme.example:8443/apply/2": FORM,
};

const VALUES = { "Atlassian leverages technologies such as ICIMS artificial intelligence features to automatically process Talent Data, including your CV": "Proceed", "Full name": "Testy", Email: "testy@example.com", Phone: "9876543210", State: "Tamil Nadu" };
const navigateAsks = [];
/** Saved steps by host and question, as the server keeps them. */
const recipes = new Map();
const costAsks = [];
const expired = [];
const ok = (route, data) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });

function stubServer(route, url) {
  const req = route.request();
  if (url.pathname === "/queue") return ok(route, JOBS);
  const nav = /^\/plans\/(\w+)\/navigate$/.exec(url.pathname);
  if (nav) {
    const ask = req.postDataJSON();
    navigateAsks.push({ job: nav[1], ...ask, screenshot: ask.screenshot ? "yes" : "no" });
    const line = ask.outline.split("\n").find((l) => l.includes("Join us"));
    return ok(route, line
      ? { action: "click", ref: line.split(" | ")[0], why: "stub: the link to apply", cost: 0.01, spent: 0.01 }
      : { action: "stuck", ref: "", why: "stub: nothing to click", cost: 0.01, spent: 0.01 });
  }
  const exp = /^\/jobs\/(\w+)\/expire$/.exec(url.pathname);
  if (exp) {
    expired.push({ job: exp[1], ...req.postDataJSON() });
    return ok(route, { jobId: exp[1], status: "expired" });
  }
  if (/^\/plans\/\w+\/page$/.test(url.pathname)) {
    const read = req.postDataJSON();
    return ok(route, {
      schemaHash: "x",
      jobCountry: null,
      summary: {},
      add: [],
      entries: read.fields.map((f) => ({
        ref: f.ref,
        label: f.label,
        section: "main",
        type: f.kind === "dropdown" ? "select" : "text",
        required: true,
        actionClass: "auto",
        status: VALUES[f.label] ? "fill" : "skip",
        value: VALUES[f.label] ?? null,
        optionValues: null,
        source: "bank:stub",
      })),
    });
  }
  if (url.pathname === "/recipes") {
    if (req.method() === "GET")
      return ok(route, [...recipes.values()].filter((r) => r.host === url.searchParams.get("host")));
    const body = req.postDataJSON();
    const labelKey = body.label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const prior = recipes.get(body.host + labelKey) ?? { worked: 0, failed: 0 };
    recipes.set(body.host + labelKey, {
      host: body.host,
      labelKey,
      steps: body.steps,
      worked: prior.worked + (body.ok ? 1 : 0),
      failed: prior.failed + (body.ok ? 0 : 1),
    });
    return ok(route, {});
  }
  const cost = /^\/trace\/jobs\/(\w+)\/cost$/.exec(url.pathname);
  if (cost) {
    costAsks.push(cost[1]);
    return ok(route, { cost: 0.07, calls: 2, unpriced: 0 });
  }
  if (url.pathname === "/runs" && req.method() === "POST") return ok(route, { id: "stub-run" });
  return ok(route, req.method() === "GET" ? [] : {});
}

const profile = mkdtempSync(path.join(tmpdir(), "copilot-ap-"));
// The careers sites come from a local HTTPS server: Playwright can't intercept the first load of
// a tab the extension opens itself. A throwaway certificate; *.example resolves to it.
const keyFile = path.join(profile, "key.pem");
const certFile = path.join(profile, "cert.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=careers.example", "-keyout", keyFile, "-out", certFile,
], { stdio: "ignore" });
const sites = https.createServer(
  { key: readFileSync(keyFile), cert: readFileSync(certFile) },
  (req, res) => {
    const body = SITES[`https://${req.headers.host}${req.url}`];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "<h1>Not here</h1>");
  },
);
await new Promise((resolve) => sites.listen(8443, "127.0.0.1", resolve));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--host-resolver-rules=MAP *.example 127.0.0.1",
    "--ignore-certificate-errors",
  ],
});
const failures = [];
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures.push(name);
};
const formStates = async () =>
  Promise.all(
    context
      .pages()
      .filter((p) => /\/(form|apply)\//.test(p.url()))
      .map((p) =>
        p.evaluate(() => ({
          url: location.href,
          name: document.getElementById("name")?.value,
          email: document.getElementById("email")?.value,
          state: document.getElementById("st_text")?.textContent,
        })),
      ),
  );

let panel;
try {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host === SERVER_HOST) return stubServer(route, url);
    // The careers sites go to the local server; anything else real is refused.
    if (url.hostname.endsWith(".example")) return route.continue();
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
  await panel.locator("#queue li").first().waitFor();
  // As narrow as a side panel gets: nothing may be wider than it.
  await panel.setViewportSize({ width: 360, height: 900 });
  await panel.locator("#autopilot-start").click();

  // 1. Highest score first: a dead link, put to you as closed. You skip it (nothing expired).
  const ask = panel.locator("#autopilot-ask");
  await ask.getByText("Engineer gone", { exact: false }).waitFor({ timeout: 30_000 });
  const goneText = await ask.innerText();
  check(
    "highest score first; a dead link is put to you as closed, without asking Claude",
    /looks closed/.test(goneText) && /link is broken/.test(goneText) && navigateAsks.length === 0,
    goneText.replace(/\s+/g, " ").slice(0, 160),
  );
  await ask.getByRole("button", { name: "Skip this job" }).click();

  // A Greenhouse posting that closed: put to you the same way, before any run starts.
  await ask.getByText("Engineer ghclosed", { exact: false }).waitFor({ timeout: 30_000 });
  check("a closed Greenhouse posting is put to you before its run", /looks closed/.test(await ask.innerText()));
  await ask.getByRole("button", { name: "Skip this job" }).click();

  // 2. The closed posting. You're asked; Mark expired.
  await ask.getByText("Engineer closed", { exact: false }).waitFor({ timeout: 30_000 });
  check("a page saying the posting is closed is put to you", /looks closed/.test(await ask.innerText()));
  await ask.getByRole("button", { name: "Mark expired" }).click();
  await panel.getByText("Engineer puzzle").first().waitFor({ timeout: 30_000 });
  check(
    "marked expired in Job Ops with what the page said",
    expired.length === 1 && expired[0].job === "closed" && /no longer available/.test(expired[0].reason),
    JSON.stringify(expired),
  );

  // 2. No Apply wording: Claude picks "Join us"; the form is filled, its search dropdown too.
  const applied = panel.locator("#run-box").getByRole("button", { name: "I applied" });
  // The page is filled when the run asks you to check it ("I applied" shows all along).
  const reviewing = () =>
    panel.locator("#run-box").getByText("Check this page", { exact: false }).waitFor({ timeout: 90_000 });
  await reviewing();
  const puzzleAsk = navigateAsks.find((a) => a.job === "puzzle");
  check(
    "Claude asked only when plain code found no Apply button, with the page's outline and a screenshot",
    navigateAsks.length === 1 && puzzleAsk?.outline.includes("Join us") && puzzleAsk.screenshot === "yes",
    `${navigateAsks.length} asks`,
  );
  const widths = await panel.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: innerWidth }));
  check("the run fits a narrow side panel (long questions, the Fill from… picker)", widths.scroll <= widths.view, JSON.stringify(widths));
  let forms = await formStates();
  const puzzle = forms.find((f) => f.url.includes("puzzle"));
  check("form filled", puzzle?.name === "Testy" && puzzle.email === "testy@example.com", JSON.stringify(puzzle));
  check(
    "a dropdown that lists choices only after typing in its own search box",
    puzzle?.state === "Tamil Nadu",
    puzzle?.state,
  );
  const bar = await panel.locator("#autopilot-status").innerText();
  check("the bar shows what Claude has cost on this job", bar.includes("Claude on this job: $0.07"), bar.replace(/\s+/g, " ").slice(0, 160));
  await applied.click();

  // The same site again: the way learned on the last job, no Claude.
  await panel.locator("#autopilot-status").getByText("Engineer puzzle2").waitFor({ timeout: 30_000 });
  await reviewing();
  const way = [...recipes.values()].find((r) => r.labelKey.startsWith("way to the application form"));
  check(
    "the way to the form is kept for the site and used again without Claude",
    way?.host === "careers.puzzle.example:8443" &&
      way.steps[0]?.value === "Join us →" &&
      way.worked === 2 &&
      navigateAsks.filter((a) => a.job === "puzzle2").length === 0,
    JSON.stringify(way),
  );
  await applied.click();

  // 3. Apply now opens the form in a new tab: followed there and filled; LinkedIn's never clicked.
  await panel.locator("#autopilot-status").getByText("Engineer acme").waitFor({ timeout: 30_000 });
  await reviewing();
  forms = await formStates();
  const acme = forms.find((f) => f.url.includes("acme"));
  check("the form's new tab followed and filled", acme?.name === "Testy" && acme.state === "Tamil Nadu", JSON.stringify(acme));
  check("Claude not asked when an Apply button was clear", navigateAsks.length === 1);
  check(
    "LinkedIn never opened",
    !context.pages().some((p) => p.url().includes("linkedin.com")),
  );
  // You abort this one yourself: asked whether to go on (Next job) or stop.
  await panel.locator("#run-box").getByRole("button", { name: "Abort" }).click();
  await ask.getByText("You stopped this application").waitFor({ timeout: 30_000 });
  check("after you abort, you're asked whether to go on", true);
  await ask.getByRole("button", { name: "Next job" }).click();
  await panel.getByText("Autopilot finished", { exact: false }).waitFor({ timeout: 30_000 });
  check("autopilot finishes when the queue is done", true);
  check("no errors in the side panel", errors.length === 0, errors.join("; "));
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${error}`);
  console.log(JSON.stringify(navigateAsks.map(({ url, title, text, outline, history }) => ({ url, title, text, outline, history }))));
} finally {
  await context.close();
  sites.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} failed` : "\nAll passed");
process.exit(failures.length ? 1 : 0);
