// Dry run of a supervised fill on a REAL Greenhouse form, driven through the built extension.
// Every non-GET request except to the apply-assistant server is blocked, so nothing is uploaded
// to Greenhouse and nothing can be submitted. The run is aborted at review.
//   node e2e/fill-dry-run.e2e.mjs <screenshot-dir> [job title substring]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const shots = process.argv[2];
const jobTitle = process.argv[3] ?? "Senior Full Stack Developer";
const SERVER_HOST = "apply.hueint.com";
const mask = (v) => (v.length <= 2 ? v : `${v[0]}***(${v.length})`);

const context = await chromium.launchPersistentContext(
  mkdtempSync(path.join(tmpdir(), "copilot-")),
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  },
);
const blocked = [];
await context.route("**/*", (route) => {
  const req = route.request();
  if (req.method() === "GET" || new URL(req.url()).host === SERVER_HOST)
    return route.continue();
  blocked.push(`${req.method()} ${new URL(req.url()).host}`);
  return route.abort();
});

const worker =
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const panel = await context.newPage();
const errors = [];
panel.on("pageerror", (e) => errors.push(e.message));
await panel.goto(
  `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
);
await panel.getByLabel("Username").fill(process.env.username ?? "");
await panel.getByLabel("Password").fill(process.env.password ?? "");
await panel.getByRole("button", { name: "Sign in" }).click();
await panel
  .locator("#queue li.clickable", { hasText: jobTitle })
  .first()
  .click();
await panel.getByRole("button", { name: "Start supervised fill" }).waitFor();
await panel.locator("#plan select").selectOption("1");
const postingPromise = context.waitForEvent("page");
await panel.getByRole("button", { name: "Start supervised fill" }).click();
const posting = await postingPromise;

const clicks = [];
// Optional trace of one field while the run works (WATCH=candidate-location).
const watchId = process.env.WATCH;
let lastSeen = "";
const watch = async () => {
  if (!watchId) return;
  for (const frame of posting.frames()) {
    const seen = await frame
      .evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const single =
          el.closest(".select__control")?.querySelector(".select__single-value")
            ?.textContent ?? "";
        return `typed="${el.value}" chosen="${single}" menu=${!!document.querySelector(".select__menu")} step=${document.getElementById("ac-badge")?.textContent ?? ""}`;
      }, watchId)
      .catch(() => null);
    if (seen && seen !== lastSeen) {
      lastSeen = seen;
      console.log(
        `[watch ${((Date.now() - started) / 1000).toFixed(1)}s] ${seen}`,
      );
    }
  }
};
const started = Date.now();
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  const text =
    (await panel
      .locator("#run-box")
      .textContent()
      .catch(() => "")) ?? "";
  if (text.includes("click Submit yourself")) break;
  if (
    /No application form|took too long|Couldn't/.test(text) &&
    !text.includes("Timeline")
  ) {
    console.log("run failed to start:", text.slice(0, 200));
    break;
  }
  const approve = panel.getByRole("button", { name: "Approve", exact: true });
  if (await approve.isVisible().catch(() => false)) {
    const label =
      (await panel.locator(".step-card strong").first().textContent()) ?? "";
    clicks.push(label);
    await approve.click().catch(() => {});
  }
  await watch();
  await panel.waitForTimeout(150);
}

await panel.waitForTimeout(2500); // review re-checks every field before it shows problems
const runText = (await panel.locator("#run-box").textContent()) ?? "";
const timeline = await panel.locator(".timeline li").allTextContents();
if (shots) {
  await posting.screenshot({
    path: path.join(shots, "dry-run-form.png"),
    fullPage: true,
  });
  await panel.screenshot({
    path: path.join(shots, "dry-run-panel.png"),
    fullPage: true,
  });
}
// Read the real form back, independently of the extension.
const form =
  posting.frames().find((f) => f.url().includes("greenhouse")) ??
  posting.mainFrame();
const readBack = await form.evaluate(() => {
  const val = (sel) => document.querySelector(sel)?.value ?? null;
  const shown = (sel) =>
    document
      .querySelector(sel)
      ?.closest(".select__control, .select-shell, .select")
      ?.querySelector(".select__single-value")
      ?.textContent?.trim() ?? null;
  const questions = [...document.querySelectorAll("[id^=question_]")].map(
    (el) => [el.id, el.value || shown(`[id="${el.id}"]`)],
  );
  return {
    first_name: val("#first_name"),
    last_name: val("#last_name"),
    email: val("#email"),
    phone: val("#phone"),
    country: shown("#country"),
    location: shown("#candidate-location"),
    locationTyped: val("#candidate-location"),
    resume:
      document.querySelector("#resume")?.files?.[0]?.name ??
      document
        .querySelector("[class*=file] , .resume")
        ?.textContent?.trim()
        ?.slice(0, 60) ??
      null,
    questions,
  };
});
await panel
  .getByRole("button", { name: "Abort" })
  .click()
  .catch(() => {});
await panel.waitForTimeout(1500);
const endText = (await panel.locator("#run-box").textContent()) ?? "";

console.log(
  JSON.stringify(
    {
      reachedReview: runText.includes("click Submit yourself"),
      approvalsClicked: clicks.length,
      timeline,
      readBack: Object.fromEntries(
        Object.entries(readBack).map(([k, v]) => [
          k,
          Array.isArray(v)
            ? v.map(([id, x]) => [id, x ? mask(String(x)) : x])
            : v
              ? mask(String(v))
              : v,
        ]),
      ),
      problemsAtReview: [...runText.matchAll(/On the page: ([^.]*)/g)].map(
        (m) => m[1],
      ),
      afterAbort: endText.slice(0, 160),
      blockedRequests: [...new Set(blocked)],
      errors,
    },
    null,
    1,
  ),
);
await context.close();
