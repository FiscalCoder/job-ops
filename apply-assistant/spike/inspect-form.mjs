// M0 spike: open a live Greenhouse job page and print the application form's
// structure (read-only: nothing is typed, nothing is submitted).
// Usage: node apply-assistant/spike/inspect-form.mjs <job-url> [more urls...]
import { chromium } from "playwright";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: node inspect-form.mjs <greenhouse-job-url> [...]");
  process.exit(1);
}

const browser = await chromium.launch();
try {
  for (const url of urls) {
    const page = await browser.newPage();
    // Hard safety: abort every non-GET request, so nothing can be posted.
    await page.route("**/*", (route) =>
      route.request().method() === "GET" ? route.continue() : route.abort(),
    );
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    const frames = page
      .frames()
      .filter((f) => /greenhouse\.io/.test(f.url()) || f === page.mainFrame());
    for (const frame of frames) {
      const report = await frame.evaluate(() => {
        const form = document.querySelector(
          "form#application-form, form#application_form, form[action*='applications'], form",
        );
        if (!form) return null;
        const labelFor = (el) => {
          const id =
            el.id &&
            document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          return (
            id?.textContent ||
            el.getAttribute("aria-label") ||
            el.closest("label")?.textContent ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 70);
        };
        const fields = [
          ...form.querySelectorAll(
            "input, textarea, select, [role='combobox']",
          ),
        ].map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || el.getAttribute("role") || "",
          id: el.id || "",
          name: el.getAttribute("name") || "",
          label: labelFor(el),
          required: el.required || el.getAttribute("aria-required") === "true",
          hidden: el.offsetParent === null,
        }));
        const sections = [
          ...form.querySelectorAll("h2, h3, legend, fieldset > div > h3"),
        ].map((h) => h.textContent.trim().slice(0, 50));
        const buttons = [...form.querySelectorAll("button")]
          .map((b) => (b.textContent || "").trim().slice(0, 40))
          .filter(Boolean);
        return {
          action: form.getAttribute("action") || "",
          sections,
          buttons,
          fields,
        };
      });
      if (!report) continue;
      console.log(`\n=== ${url}\n--- frame: ${frame.url().slice(0, 100)}`);
      console.log("sections:", report.sections.join(" | "));
      console.log("buttons:", report.buttons.join(" | "));
      for (const f of report.fields) {
        if (f.type === "hidden") continue;
        console.log(
          `  ${f.required ? "*" : " "} ${f.tag}[${f.type}] id=${f.id} name=${f.name}${f.hidden ? " (not visible)" : ""}  "${f.label}"`,
        );
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
