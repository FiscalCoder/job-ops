import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  type JobOpsApi,
  JobOpsError,
  type JobOpsJob,
} from "../src/jobops/client.js";
import { openStore } from "../src/store/db.js";
import { fakeDesignResume } from "../test/fixtures/fake-resume.js";
import newrelic from "../test/fixtures/gh-newrelic.json" with { type: "json" };

/**
 * The web page in a real browser against a real apply-assistant (fake Job Ops):
 * sign in → queue → plan → "Answer it" → save → plan updated.
 */

const SHOTS = process.env.E2E_SCREENSHOTS;

const job: JobOpsJob = {
  id: "job-1",
  title: "Senior Backend Engineer",
  employer: "Acme",
  status: "ready",
  jobUrl: "https://job-boards.greenhouse.io/acme/jobs/11",
  applicationLink: null,
  suitabilityScore: 84,
};

const jobOps: JobOpsApi = {
  login: async (u, p) => {
    if (u === "me" && p === "pw") return { token: "good", expiresIn: 3600 };
    throw new JobOpsError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  },
  me: async (t) => {
    if (t === "good") return { id: "u1", username: "me" };
    throw new JobOpsError(401, "UNAUTHORIZED", "nope");
  },
  listJobs: async () => ({ jobs: [job], total: 1, revision: "r" }),
  getJob: async () => ({
    ...job,
    location: "Bengaluru, India",
    jobDescription: "x",
  }),
  updateJob: async () => undefined,
  addNote: async () => undefined,
  getPdf: async () => new Uint8Array(),
  markApplied: async () => {},
  skipJob: async () => {},
  getDesignResume: async () => fakeDesignResume,
};

let server: Server;
let base: string;
let browser: Browser;
let page: Page;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer good",
    },
    body: JSON.stringify(body),
  });

const shot = async (name: string) => {
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

beforeAll(async () => {
  server = createApp({
    jobOps,
    db: openStore(":memory:"),
    authCacheSeconds: 60,
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // What the extension would report: posting live, then its form.
  await post("/lookups/results", {
    type: "job",
    jobId: "job-1",
    token: "acme",
    postingId: "11",
    url: "https://job-boards.greenhouse.io/acme/jobs/11",
    live: true,
  });
  await post("/lookups/results", {
    type: "schema",
    jobId: "job-1",
    token: "acme",
    postingId: "11",
    payload: {
      ...structuredClone(newrelic),
      id: 11,
      location: { name: "Bengaluru, India" },
    },
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("pageerror", (e) => {
    throw e;
  });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe("web page", () => {
  it("rejects a wrong password, then signs in", async () => {
    await page.goto(base);
    await page.getByLabel("Username").fill("me");
    await page.getByLabel("Password").fill("wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect
      .poll(() => page.locator("#login-error").textContent())
      .toBe("Wrong username or password.");
    await page.getByLabel("Password").fill("pw");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Queue" }).waitFor();
  });

  it("shows the job with its Greenhouse match and plan counts", async () => {
    const row = page.locator("#queue-list tr", {
      hasText: "Senior Backend Engineer",
    });
    await row.waitFor();
    expect(await row.textContent()).toContain("On Greenhouse");
    expect(await row.textContent()).toMatch(/\d+ need you/);
    await shot("1-queue");
  });

  it("opens the plan and links a missing answer to the answer bank", async () => {
    await page
      .locator("#queue-list tr", { hasText: "Senior Backend Engineer" })
      .click();
    const firstName = page.locator("#plan tr", { hasText: /^First Name/ });
    await firstName.waitFor();
    expect(await firstName.textContent()).toContain("needs you");
    expect(await page.locator("#plan").textContent()).toContain("job in India");
    await shot("2-plan");
    await firstName.getByRole("link", { name: "Answer it →" }).click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("bank-identity.first_name");
    await shot("3-bank");
  });

  it("saves answers, rebuilds plans, and the plan then fills them", async () => {
    await page.locator('[id="bank-identity.first_name"]').fill("Test");
    await page.locator('[id="bank-work.authorized_countries"]').fill("India");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(() => page.locator("#toast").textContent())
      .toBe("Saved 2 answers · 1 plan updated");
    expect(
      await page.locator('[id="bank-identity.first_name"]').inputValue(),
    ).toBe("Test");

    await page.getByRole("button", { name: "Queue" }).click();
    await page
      .locator("#queue-list tr", { hasText: "Senior Backend Engineer" })
      .click();
    const firstName = page.locator("#plan tr", { hasText: /^First Name/ });
    await expect.poll(() => firstName.textContent()).toContain("fills");
    const sponsorship = page.locator("#plan tr", {
      hasText: "require sponsorship",
    });
    expect(await sponsorship.textContent()).toContain("No");
    await shot("4-plan-after");
  });

  it("shows an example for every answer and explains a value it can't use", async () => {
    await page.getByRole("button", { name: "Answer bank" }).click();
    const salary = page.locator('[data-field="comp.current"]');
    await salary.waitFor();
    expect(await salary.locator(".hint").textContent()).toContain(
      "Example: INR 3000000",
    );
    await salary.locator("input").fill("lots");
    await page.locator('[data-field="identity.last_name"] input').fill("C");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(() => page.locator("#toast").textContent())
      .toBe("Saved 1 · 1 need fixing (see the red notes)");
    expect(await salary.locator(".field-error").textContent()).toContain(
      "e.g. INR 3000000",
    );
    expect(await salary.locator("input").inputValue()).toBe("lots");
    expect(
      await page
        .locator('[data-field="identity.last_name"] input')
        .inputValue(),
    ).toBe("C");
    await salary.locator("input").fill("30 LPA");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(() => salary.locator("input").inputValue())
      .toBe("INR 3000000");
    await shot("6-bank-formats");
  });

  it("shows a job's trace on the Timeline, with sandboxed snapshots and an export", async () => {
    const cspErrors: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
    });
    const jpeg = (
      await page.screenshot({ type: "jpeg", quality: 40 })
    ).toString("base64");
    await post("/trace/events", {
      events: [
        {
          jobId: "job-1",
          source: "extension",
          kind: "step-start",
          stepSeq: 1,
          message: "Filling First Name",
          data: { value: "Test" },
        },
        {
          jobId: "job-1",
          source: "extension",
          kind: "step-failed",
          stepSeq: 2,
          message: 'Location: No place matching "Chennai" appeared',
        },
      ],
    });
    await post("/trace/snapshots", {
      jobId: "job-1",
      kind: "dom",
      reason: "step 2 failed: Location",
      url: "https://job-boards.greenhouse.io/acme/jobs/11",
      content: `<form><label>Location <input value="Chennai"></label><img src="x" onerror="parent.document.title='pwned'"></form>`,
    });
    await post("/trace/snapshots", {
      jobId: "job-1",
      kind: "screenshot",
      reason: "step 2 failed: Location",
      content: jpeg,
    });

    await page.getByRole("button", { name: "Timeline" }).click();
    const row = page.locator("#timeline-box tr", {
      hasText: "Senior Backend Engineer",
    });
    await row.waitFor();
    expect(await row.textContent()).toContain("1 problem");
    await row.click();
    await page.getByText("Location: No place matching").waitFor();

    await page.getByRole("button", { name: "View page" }).click();
    const frame = page.frameLocator("iframe.snapshot");
    await expect
      .poll(() => frame.locator("input").inputValue())
      .toBe("Chennai");
    expect(await page.title()).not.toBe("pwned");

    await page.getByRole("button", { name: "View screenshot" }).click();
    await expect
      .poll(() =>
        page
          .locator("img.snapshot")
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await shot("7-timeline");

    await page.getByLabel("Only problems and snapshots").check();
    expect(await page.getByText("Filling First Name").count()).toBe(0);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export trail (JSON)" }).click(),
    ]);
    const bundle = JSON.parse(
      await new Response(
        (await download.createReadStream()) as unknown as ReadableStream,
      ).text(),
    );
    expect(bundle.data.events.length).toBeGreaterThanOrEqual(4);
    expect(bundle.data.snapshots[0].html).toContain("Chennai");
    expect(cspErrors).toEqual([]);
    await page.getByRole("button", { name: "All jobs" }).click();
  });

  it("shows the M4 targets on Progress, and remembered answers you can forget", async () => {
    await page.getByRole("button", { name: "Progress" }).click();
    await page
      .getByRole("heading", { name: "Supervised applications" })
      .waitFor();
    expect(await page.locator("#progress-box tbody tr").count()).toBe(6);
    expect(await page.locator("#progress-box").textContent()).toContain(
      "No supervised application submitted yet",
    );
    await shot("8-progress");

    await post("/learned", {
      jobId: "job-1",
      label: "Why do you want to work at Acme?",
      type: "textarea",
      value: "Because of the platform team.",
      how: "edited",
    });
    await page.getByRole("button", { name: "Answer bank" }).click();
    const row = page.locator("#learned tr", {
      hasText: "Why do you want to work at Acme?",
    });
    await row.waitFor();
    expect(await row.textContent()).toContain("Because of the platform team.");
    await shot("9-remembered");
    await row.getByRole("button", { name: "Forget" }).click();
    await page.getByText("Nothing remembered yet.").waitFor();
  });

  it("keeps working at phone width", async () => {
    await page.setViewportSize({ width: 380, height: 800 });
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter(
          (n) => n.getBoundingClientRect().right > window.innerWidth + 0.5,
        )
        .map(
          (n) =>
            `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}.${n.className} ${Math.round(n.getBoundingClientRect().right)}`,
        )
        .slice(0, 8),
    );
    expect(wide).toEqual([]);
    await shot("5-phone");
  });
});
