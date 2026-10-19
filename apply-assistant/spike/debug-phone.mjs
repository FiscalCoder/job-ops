// M0 spike debug: how does the intl-tel-input phone field keep its value? Fake data; non-GET aborted.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route("**/*", (r) =>
  r.request().method() === "GET" ? r.continue() : r.abort(),
);
await page.goto("https://job-boards.greenhouse.io/newrelic/jobs/5453390008", {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector("#phone");
const read = () => page.evaluate(() => document.getElementById("phone").value);
// country first
await page.click("#country");
await page.keyboard.type("India", { delay: 30 });
await page
  .locator(".select__option:visible", { hasText: /^India/ })
  .first()
  .click();
await page.waitForTimeout(500);
for (const [label, fn] of [
  [
    "insertText",
    async () => {
      await page.click("#phone");
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText("9876543210");
    },
  ],
  [
    "keystrokes",
    async () => {
      await page.click("#phone");
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("9876543210", { delay: 40 });
    },
  ],
]) {
  await fn();
  const t0 = await read();
  await page.click("#first_name");
  await page.keyboard.type("T", { delay: 30 });
  await page.waitForTimeout(800);
  console.log(
    `${label}: right after="${t0}" after moving on="${await read()}"`,
  );
}
await browser.close();
