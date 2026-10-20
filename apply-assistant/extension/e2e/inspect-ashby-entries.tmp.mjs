import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route("**/*", (r) => (r.request().method() === "GET" || r.request().url().includes("non-user-graphql") ? r.continue() : r.abort()));
await page.goto(process.argv[2], { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const out = await page.evaluate(() => [...document.querySelectorAll(".ashby-application-form-field-entry")].map((e) => {
  const label = e.querySelector("label");
  const attrs = [...e.attributes].map((a) => `${a.name}=${a.value.slice(0, 60)}`).join(" ");
  const inner = [...e.querySelectorAll("input,textarea,button,[role]")].map((i) => `${i.tagName.toLowerCase()}${i.id ? "#" + i.id.slice(0, 50) : ""}${i.getAttribute("name") ? "[name=" + i.getAttribute("name").slice(-40) + "]" : ""}${i.getAttribute("role") ? "[role=" + i.getAttribute("role") + "]" : ""}${i.getAttribute("type") ? "[type=" + i.getAttribute("type") + "]" : ""}`).slice(0, 4).join(" ");
  return `${attrs}\n    label for=${label?.getAttribute("for")?.slice(0, 60)} text=${label?.textContent?.trim().slice(0, 40)}\n    ${inner}`;
}));
console.log(out.join("\n"));
const opts = await page.evaluate(() => [...document.querySelectorAll("input[type=radio]")].slice(0, 2).map((r) => `${r.id.slice(-30)} label=${document.querySelector(`label[for="${r.id}"]`)?.textContent?.trim()} parentText=${r.parentElement?.textContent?.trim().slice(0, 30)}`));
console.log(opts.join("\n"));
await browser.close();
