// M0 spike debug: why do filled values revert, and how do the comboboxes open?
// Fake data only; every non-GET request aborted; Submit never clicked.
import { chromium } from "playwright";

const URL = "https://job-boards.greenhouse.io/newrelic/jobs/5453390008";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("**/*", (r) =>
  r.request().method() === "GET" ? r.continue() : r.abort(),
);
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#first_name");
await page.waitForTimeout(2000);

const probe = () =>
  page.evaluate(() => {
    const el = document.getElementById("first_name");
    const key = Object.keys(el).find((k) => k.startsWith("__reactProps"));
    return {
      value: el.value,
      hasReactProps: Boolean(key),
      reactValueProp: key ? el[key].value : "(n/a)",
    };
  });

// 1) synthetic native-setter fill, then watch over time
await page.evaluate(() => {
  const el = document.getElementById("first_name");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
    el,
    "Synthetic",
  );
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
console.log("synthetic t=0", await probe());
await page.click("#last_name");
await page.waitForTimeout(1500);
console.log("synthetic after focus moves", await probe());

// 2) trusted typing (CDP keyboard) for comparison
await page.fill("#first_name", "");
await page.type("#first_name", "Trusted", { delay: 20 });
await page.click("#last_name");
await page.waitForTimeout(1500);
console.log("trusted after focus moves", await probe());

// 3) combobox structure + what opens it
const combo = await page.evaluate(() => {
  const input = document.getElementById("country");
  const chain = [];
  let n = input;
  for (let i = 0; i < 5 && n; i++, n = n.parentElement)
    chain.push(
      `${n.tagName.toLowerCase()}.${(n.className || "").toString().slice(0, 60)}`,
    );
  return {
    role: input.getAttribute("role"),
    ariaExpanded: input.getAttribute("aria-expanded"),
    readOnly: input.readOnly,
    chain,
  };
});
console.log("country combobox:", JSON.stringify(combo, null, 1));

await page.evaluate(() => {
  const input = document.getElementById("country");
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      code: "ArrowDown",
      keyCode: 40,
      bubbles: true,
    }),
  );
});
await page.waitForTimeout(800);
const afterKey = await page.evaluate(() => ({
  expanded: document.getElementById("country").getAttribute("aria-expanded"),
  options: [...document.querySelectorAll("[role='option']")]
    .slice(0, 5)
    .map(
      (o) =>
        `${o.className.toString().slice(0, 40)} :: ${o.textContent.trim()}`,
    ),
}));
console.log("synthetic ArrowDown →", JSON.stringify(afterKey));

await page.click("#country");
await page.keyboard.type("Ind", { delay: 30 });
await page.waitForTimeout(800);
const afterTrusted = await page.evaluate(() => ({
  expanded: document.getElementById("country").getAttribute("aria-expanded"),
  options: [...document.querySelectorAll("[role='option']")]
    .slice(0, 5)
    .map(
      (o) =>
        `${o.className.toString().slice(0, 40)} :: ${o.textContent.trim()}`,
    ),
  listbox:
    document
      .querySelector("[role='listbox']")
      ?.className?.toString()
      .slice(0, 60) ?? null,
}));
console.log("trusted click+type →", JSON.stringify(afterTrusted));
await browser.close();
