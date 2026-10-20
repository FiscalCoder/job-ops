// Loads the built extension in Chromium and drives its side panel against a real server.
//   node e2e/sidepanel.e2e.mjs <screenshot-dir>   (needs username/password in the env; build first)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const shots = process.argv[2];
const profile = mkdtempSync(path.join(tmpdir(), "copilot-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});
const worker =
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extensionId = new URL(worker.url()).host;
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
await page.getByLabel("Username").fill(process.env.username ?? "");
await page.getByLabel("Password").fill(process.env.password ?? "");
await page.getByRole("button", { name: "Sign in" }).click();
await page.locator("#queue li").first().waitFor({ timeout: 30_000 });
await page.getByRole("button", { name: "Run now" }).click();
await page
  .getByRole("button", { name: "Run now" })
  .waitFor({ timeout: 300_000 });
const lastRun = await page.locator("#last-run").textContent();
const runLines = await page.locator("#run-lines li").allTextContents();
const queue = await page.locator("#queue li").allTextContents();
await page.locator("#queue li.clickable").first().click();
await page.locator("#plan .entry").first().waitFor();
const planEntries = await page.locator("#plan .entry").count();
if (shots)
  await page.screenshot({
    path: path.join(shots, "sidepanel.png"),
    fullPage: true,
  });
console.log(
  JSON.stringify(
    {
      extensionId,
      lastRun,
      runLines,
      queue: queue.map((q) => q.slice(0, 80)),
      planEntries,
      errors,
    },
    null,
    1,
  ),
);
await context.close();
rmSync(profile, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
});
