// The apply kit in a real Chrome with the built extension, against a real apply-assistant (fake
// Job Ops, in-memory database). Every hostname resolves to a local HTTPS stub, so nothing real
// is read or written. The test careers page is served on the apply-assistant host, which the
// extension may already script, so fill-by-click runs without the all-sites permission prompt.
//   cd apply-assistant && node --import tsx extension/e2e/kit.e2e.mjs [screenshot-dir]
//   (build the extension first; needs openssl on PATH for the throwaway certificate)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../../server/src/http/app.ts";
import { JobOpsError } from "../../server/src/jobops/client.ts";
import { createAnswerBankRepo } from "../../server/src/store/answer-bank-repo.ts";
import { openStore } from "../../server/src/store/db.ts";
import { fakeDesignResume } from "../../server/test/fixtures/fake-resume.ts";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const shots = process.argv[2];
const HOST = "apply.hueint.com";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

const job = {
  id: "job-kit",
  title: "Platform Engineer",
  employer: "Acme Robotics",
  status: "ready",
  jobUrl: "https://www.linkedin.com/jobs/view/4400000001",
  applicationLink: `https://${HOST}/test/careers`,
  suitabilityScore: 80,
};
/** The job's status in the fake Job Ops, and the actions it was asked for. */
let jobStatus = "ready";
const jobOpsCalls = [];
const jobOps = {
  login: async () => ({ token: "good", expiresIn: 3600 }),
  me: async (t) => {
    if (t === "good") return { id: "u1", username: "me" };
    throw new JobOpsError(401, "UNAUTHORIZED", "nope");
  },
  listJobs: async () => {
    const jobs = jobStatus === "ready" ? [job] : [];
    return { jobs, total: jobs.length, revision: jobStatus };
  },
  getJob: async (_t, id) => {
    if (id !== job.id) throw new JobOpsError(404, "NOT_FOUND", "Job not found");
    return {
      ...job,
      status: jobStatus,
      location: "Remote",
      jobDescription: "Build things",
      tailoredSummary: "Platform engineer who ships.",
    };
  },
  updateJob: async () => {},
  addNote: async () => {},
  getPdf: async () => new Uint8Array(PDF),
  markApplied: async () => {
    jobOpsCalls.push("apply");
    jobStatus = "applied";
  },
  skipJob: async () => {
    jobOpsCalls.push("skip");
    jobStatus = "skipped";
  },
  getDesignResume: async () => fakeDesignResume,
};

const db = openStore(":memory:");
const bank = createAnswerBankRepo(db);
for (const [key, value] of [
  ["identity.first_name", "Test"],
  ["identity.last_name", "C"],
  ["work.notice_period", "30"],
  ["eeo.gender", "Decline to self-identify"],
])
  bank.upsert({ key, value, isProtected: false, updatedBy: "you" });
const app = createApp({ jobOps, db, authCacheSeconds: 60 });

// A careers page like the ones the kit is for: a React-style field that keeps only what
// arrives through input events, a resume upload next to a cover-letter upload, and a
// same-site iframe with its own question.
const careers = `<!doctype html><html><body>
<h1>Apply to Acme Robotics</h1>
<form id="apply">
  <label for="full">Full name</label><input id="full" name="full_name">
  <label for="email">Email address</label><input id="email" type="email" name="email">
  <label>Cover letter <input type="file" name="cover"></label>
  <label>Resume / CV <input type="file" name="resume" accept=".pdf"></label>
  <p id="state"></p>
</form>
<iframe src="/test/embed" title="questions" style="width:100%;height:120px"></iframe>
<script>
  // Controlled field: the value only survives a blur if an input event carried it.
  const email = document.getElementById("email");
  let state = "";
  email.addEventListener("input", () => { state = email.value; });
  email.addEventListener("blur", () => { email.value = state; });
  document.querySelector('[name=resume]').addEventListener("change", (e) => {
    document.getElementById("state").textContent = "resume: " + e.target.files[0].name + " " + e.target.files[0].size;
  });
</script>
</body></html>`;
const embed = `<!doctype html><html><body><label for="why">Why Acme?</label><textarea id="why"></textarea></body></html>`;

const work = mkdtempSync(path.join(tmpdir(), "kit-"));
const key = path.join(work, "key.pem");
const cert = path.join(work, "cert.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=stub",
    "-keyout",
    key,
    "-out",
    cert,
  ],
  { stdio: "ignore" },
);
const strays = [];
const server = https.createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const page = (html) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>${html}`);
    };
    // A stand-in LinkedIn job page whose Apply opens the company's page in a new tab.
    if (host === "www.linkedin.com") {
      if (req.url?.startsWith("/jobs/view/"))
        return page(
          `<h1>Platform Engineer</h1><a id="apply" href="https://${HOST}/test/company-apply" target="_blank">Apply</a>`,
        );
      res.writeHead(404).end(); // its favicon: part of the stand-in, not a stray
      return;
    }
    if (host !== HOST) {
      strays.push(`${req.method} ${host}${req.url}`);
      res.writeHead(404).end();
      return;
    }
    if (req.url === "/test/careers" || req.url === "/test/embed") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.url === "/test/careers" ? careers : embed);
      return;
    }
    if (req.url === "/test/company-apply")
      return page("<h1>Acme Robotics careers</h1><p>Apply below.</p>");
    if (req.url?.startsWith("/test/thank-you"))
      return page("<h1>Thank you for applying!</h1>");
    app(req, res);
  },
);
await new Promise((r) => server.listen(443, "127.0.0.1", r));

const profile = mkdtempSync(path.join(tmpdir(), "kit-profile-"));
const downloads = mkdtempSync(path.join(tmpdir(), "kit-downloads-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--host-resolver-rules=MAP * 127.0.0.1",
    "--ignore-certificate-errors",
  ],
});
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error.message.split("\n").join("\n    ")}`);
  }
};

try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  // Plain downloads into a temp folder (Playwright would otherwise rename them).
  const careersPage = await context.newPage();
  await (await context.newCDPSession(careersPage)).send(
    "Browser.setDownloadBehavior",
    {
      behavior: "allow",
      downloadPath: downloads,
    },
  );
  await careersPage.goto(`https://${HOST}/test/careers`);
  const panel = await context.newPage();
  // Records what the kit copies (the real clipboard write still has to succeed).
  await panel.addInitScript(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.__copied = [];
    navigator.clipboard.writeText = async (text) => {
      await write(text);
      window.__copied.push(text);
    };
  });
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByLabel("Server").fill(`https://${HOST}`);
  await panel.getByLabel("Username").fill("me");
  await panel.getByLabel("Password").fill("pw");
  await panel.getByRole("button", { name: "Sign in" }).click();
  const clipboard = () => panel.evaluate(() => window.__copied.at(-1));

  await check(
    "every queued job has an Apply kit button that opens its kit",
    async () => {
      await panel
        .locator("#queue li", { hasText: "Platform Engineer" })
        .waitFor();
      await panel.getByRole("button", { name: "Apply kit" }).first().click();
      await panel.getByRole("heading", { name: "Work and location" }).waitFor();
      const text = await panel.locator("#kit-box").innerText();
      for (const want of [
        "Test C",
        "test@example.com",
        "Platform engineer who ships.",
        "30",
      ])
        assert.ok(text.includes(want), `kit shows ${want}`);
      assert.ok(
        !(await panel.getByText("Decline to self-identify").isVisible()),
        "sensitive answers start hidden",
      );
      if (shots)
        await panel.screenshot({ path: `${shots}/kit-1.png`, fullPage: true });
    },
  );

  await check(
    "a click fills the field selected on the page, through input events",
    async () => {
      await careersPage.bringToFront();
      await careersPage.focus("#email");
      await panel.bringToFront();
      await panel.locator(".kit-item", { hasText: "test@example.com" }).click();
      await panel
        .getByText(/Filled Email into "Email address"/)
        .waitFor({ timeout: 10_000 })
        .catch(async (error) => {
          const said = await panel
            .locator("#kit-box [aria-live]")
            .textContent();
          throw new Error(
            `${error.message.split("\n")[0]}; the panel said: ${said}`,
          );
        });
      await careersPage.bringToFront();
      await careersPage.focus("#full");
      assert.equal(
        await careersPage.inputValue("#email"),
        "test@example.com",
        "value survived blur",
      );
    },
  );

  await check("it fills a field inside a frame too", async () => {
    const frame = careersPage.frameLocator("iframe");
    await frame.locator("#why").focus();
    await panel.bringToFront();
    await panel
      .locator(".kit-item", { hasText: "Platform engineer who ships." })
      .click();
    await panel
      .getByText(/Filled Tailored summary into "Why Acme\?"/)
      .waitFor({ timeout: 10_000 });
    assert.equal(
      await frame.locator("#why").inputValue(),
      "Platform engineer who ships.",
    );
  });

  await check("with no field selected it copies instead", async () => {
    await careersPage.bringToFront();
    await careersPage.evaluate(() => document.activeElement?.blur());
    const frame = careersPage
      .frames()
      .find((f) => f.url().endsWith("/test/embed"));
    await frame?.evaluate(() => document.activeElement?.blur());
    await panel.bringToFront();
    await panel.locator(".kit-item", { hasText: "Test C" }).first().click();
    await panel
      .getByText(/Copied Full name\. Click a field on the page first/)
      .waitFor();
    assert.equal(await clipboard(), "Test C");
  });

  await check(
    "Attach resume picks the resume field, not the cover letter",
    async () => {
      await panel
        .getByRole("button", { name: "Attach resume to page" })
        .click();
      await panel
        .getByText(/Resume attached on apply\.hueint\.com/)
        .waitFor({ timeout: 10_000 });
      const state = await careersPage.locator("#state").textContent();
      assert.match(state ?? "", /^resume: Test_C_Resume\.pdf \d+$/);
      assert.equal(
        await careersPage.evaluate(
          () => document.querySelector("[name=cover]").files.length,
        ),
        0,
      );
    },
  );

  // Under automation Chrome renames downloads, so this checks the copied path is the saved
  // PDF; the JobOps/<employer - title>/ naming is covered by the unit tests (resumePath).
  await check(
    "Save resume saves the PDF and copies its full path",
    async () => {
      await panel
        .getByRole("button", { name: "Save resume, copy path" })
        .click();
      await panel
        .getByText(/Resume saved and its path copied/)
        .waitFor({ timeout: 20_000 });
      const copied = await clipboard();
      assert.ok(path.isAbsolute(copied), `absolute path: ${copied}`);
      assert.deepEqual(readFileSync(copied), PDF);
    },
  );

  await check("Ask Claude says plainly when Claude isn't set up", async () => {
    await panel.getByLabel("Question").fill("Why do you want to work here?");
    await panel.getByRole("button", { name: "Ask Claude" }).click();
    await panel
      .getByText("Claude isn't set up on the server (no Anthropic key)")
      .waitFor();
    if (shots)
      await panel.screenshot({ path: `${shots}/kit-2.png`, fullPage: true });
  });

  await check(
    "I applied and Skip job need a second click, then use Job Ops' own actions",
    async () => {
      const skip = panel.getByRole("button", { name: "Skip job" });
      const box = async (name) =>
        panel.getByRole("button", { name }).boundingBox();
      await skip.scrollIntoViewIfNeeded();
      const before = await box("Skip job");
      await skip.click();
      const armed = panel.getByRole("button", { name: "Confirm skip" });
      await armed.waitFor();
      // The armed button stays where it was, so the second click lands on it.
      const after = await armed.boundingBox();
      assert.deepEqual(
        [after?.x, after?.y],
        [before?.x, before?.y],
        "the button didn't move",
      );
      // Not confirmed in time: it goes back and nothing happens.
      await skip.waitFor({ timeout: 6_000 });
      assert.deepEqual(jobOpsCalls, []);
      await panel.getByRole("button", { name: "I applied ✓" }).click();
      await panel.getByRole("button", { name: "Confirm applied" }).click();
      assert.equal(
        (await await box("Skip job")) === null ? true : await skip.isDisabled(),
        true,
        "Skip is off once it's applied",
      );
      // The kit closes by itself: back to a fresh queue, with a note of what happened.
      await panel
        .locator("#notice", { hasText: "Marked Applied in Job Ops." })
        .waitFor({ timeout: 10_000 });
      assert.ok(await panel.locator("#kit-box").isHidden(), "kit closed");
      await panel.getByText("No Ready jobs in Job Ops.").waitFor();
      assert.deepEqual(jobOpsCalls, ["apply"]);
    },
  );

  await check(
    "the side panel recognises the job's LinkedIn page, the company page opened from it, and its confirmation page",
    async () => {
      // Back in the queue (the previous check applied to it).
      jobStatus = "ready";
      jobOpsCalls.length = 0;
      await panel.getByRole("button", { name: "Refresh" }).click();
      await panel
        .locator("#queue li", { hasText: "Platform Engineer" })
        .waitFor();
      const here = panel.locator("#here");

      const linkedIn = await context.newPage();
      await linkedIn.goto(
        "https://www.linkedin.com/jobs/view/4400000001/?refId=x",
      );
      await panel.bringToFront();
      await here
        .getByText("You're on the LinkedIn page for Platform Engineer")
        .waitFor({ timeout: 10_000 });
      assert.ok(
        await here.getByRole("button", { name: "Apply kit" }).isVisible(),
      );
      assert.equal(
        await here.getByRole("button", { name: "Fill this page" }).count(),
        0,
        "no fill on LinkedIn",
      );

      // LinkedIn's Apply opens the company's page in a new tab: same job, by lineage.
      await linkedIn.bringToFront();
      const [company] = await Promise.all([
        context.waitForEvent("page"),
        linkedIn.click("#apply"),
      ]);
      await company.waitForLoadState();
      await panel.bringToFront();
      await here
        .getByText("You're applying to Platform Engineer")
        .waitFor({ timeout: 10_000 });

      // The company page shows a confirmation: "Not yet" stops asking, "Mark Applied" marks it.
      // You're on the company tab when its confirmation loads.
      await company.bringToFront();
      await company.goto(`https://${HOST}/test/thank-you`);
      await panel.bringToFront();
      await here
        .getByText("This looks like a confirmation page")
        .waitFor({ timeout: 10_000 });
      await here.getByRole("button", { name: "Not yet" }).click();
      await panel.waitForTimeout(800);
      assert.equal(
        await here.getByText("This looks like a confirmation page").count(),
        0,
        "Not yet stops asking on that page",
      );
      assert.deepEqual(jobOpsCalls, []);
      await company.bringToFront();
      await company.goto(`https://${HOST}/test/thank-you?step=done`);
      await panel.bringToFront();
      await here
        .getByRole("button", { name: "Mark Applied" })
        .click({ timeout: 10_000 });
      await panel
        .locator("#notice", { hasText: "Marked Applied in Job Ops." })
        .waitFor({ timeout: 10_000 });
      assert.deepEqual(jobOpsCalls, ["apply"]);
      if (shots) await panel.screenshot({ path: `${shots}/kit-3-here.png` });
    },
  );

  await check(
    "every fill and copy is in the job's trace, with the field it went into",
    async () => {
      const token = await panel.evaluate(
        async () => (await chrome.storage.local.get("token")).token,
      );
      const res = await fetch(`https://127.0.0.1/trace/jobs/${job.id}`, {
        headers: { host: HOST, authorization: `Bearer ${token}` },
      }).catch(() => null);
      // Node's fetch won't take a self-signed certificate; ask through the browser instead.
      const trail = res?.ok
        ? (await res.json()).data
        : await panel.evaluate(
            async ([id, t]) => {
              const r = await fetch(
                `https://apply.hueint.com/trace/jobs/${id}`,
                {
                  headers: { authorization: `Bearer ${t}` },
                },
              );
              return (await r.json()).data;
            },
            [job.id, token],
          );
      const kinds = trail.events.map((e) => e.kind);
      for (const kind of [
        "kit-opened",
        "kit-fill",
        "kit-copy",
        "resume-attached",
        "resume-saved",
        "kit-outcome",
      ])
        assert.ok(
          kinds.includes(kind),
          `trace has ${kind} (has ${kinds.join(", ")})`,
        );
      const fill = trail.events.find((e) => e.kind === "kit-fill");
      assert.deepEqual(
        {
          key: fill.data.key,
          host: fill.data.host,
          label: fill.data.field.label,
          type: fill.data.field.type,
        },
        {
          key: "resume:email",
          host: HOST,
          label: "Email address",
          type: "email",
        },
      );
    },
  );

  await check(
    "no errors in the side panel and nothing left the machine",
    async () => {
      assert.deepEqual(errors, []);
      // Chrome's own background calls (Google sign-in, autofill) also land on the stub; ignore them.
      const chromeItself = /google\.com|googleapis\.com|gstatic\.com/;
      const lookups = /greenhouse|ashby|lever|clearbit/;
      assert.deepEqual(
        strays.filter((s) => !chromeItself.test(s) && !lookups.test(s)),
        [],
      );
    },
  );
} finally {
  await context.close();
  server.close();
  for (const dir of [profile, downloads, work])
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
