// Read-only DOM inspection of any application page (non-GET requests blocked; nothing is sent).
//   node e2e/inspect-form.mjs <application url>
import { chromium } from "playwright";

const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route("**/*", (r) =>
  r.request().method() === "GET" ||
  r.request().url().includes("non-user-graphql")
    ? r.continue()
    : r.abort(),
);
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll(
    "input, textarea, select, button, [role=combobox], [role=radio], [role=checkbox]",
  )) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && el.type !== "file") continue;
    const field = el.closest(
      "[class*=fieldEntry], [class*=_fieldEntry], .ashby-application-form-field-entry",
    );
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      id: el.id,
      name: el.getAttribute("name"),
      role: el.getAttribute("role"),
      ph: el.getAttribute("placeholder"),
      text: (el.tagName === "BUTTON" ? el.textContent : "").trim().slice(0, 40),
      label:
        field?.querySelector("label")?.textContent?.trim().slice(0, 60) ?? null,
      fieldClass: field?.className?.slice(0, 80) ?? null,
    });
  }
  return out;
});
for (const i of info) console.log(JSON.stringify(i));
await browser.close();
