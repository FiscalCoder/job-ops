// M0 spike, pass 2: comboboxes, typeaheads and repeaters through TRUSTED input
// (CDP mouse/keyboard, the same mechanism an extension gets from chrome.debugger).
// Text fields keep using the synthetic page-side filler. FAKE data only; every non-GET
// request is aborted (so nothing is uploaded or posted); Submit is never clicked.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = (
  await build({
    entryPoints: [
      path.join(here, "../extension/src/content/fillers/greenhouse.ts"),
    ],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "GHFill",
    target: "es2020",
  })
).outputFiles[0].text;

const PLANS = [
  {
    name: "newrelic",
    url: "https://job-boards.greenhouse.io/newrelic/jobs/5453390008",
    text: {
      first_name: "Test",
      last_name: "Candidate",
      preferred_name: "Test",
      email: "test.candidate@example.com",
      phone: "9876543210",
    },
    selects: [
      ["country", "India", "India"],
      ["candidate-location", "Bengaluru", "Bengaluru"],
      ["school--0", "Other", "Other"],
      ["degree--0", "Bachelor", "Bachelor"],
      ["discipline--0", "Computer Science", "Computer Sci"],
      ["question_18984069008", "India", "India"],
      ["question_18984072008", "No", "No"],
      ["question_18984075008", "No", "No"],
      ["gender", "Decline", "Decline"],
    ],
    repeat: "school--",
    file: "resume",
  },
  {
    name: "fivetran",
    url: "https://www.fivetran.com/careers/job?gh_jid=7790795003",
    reveal: "Application",
    text: {
      first_name: "Test",
      last_name: "Candidate",
      email: "test.candidate@example.com",
      phone: "9876543210",
      question_31232841003: "1 Test Street",
      question_31232843003: "Bengaluru",
    },
    selects: [
      ["country", "India", "India"],
      ["candidate-location", "Bengaluru", "Bengaluru"],
      ["question_31232850003", "LinkedIn", "Linked"],
      ["question_31232854003", "Yes", "Yes"],
    ],
    file: "resume",
  },
];

async function clickField(frame, sel) {
  await frame.evaluate(
    (s) => document.querySelector(s)?.scrollIntoView({ block: "center" }),
    sel,
  );
  try {
    await frame.click(sel, { timeout: 4000 });
  } catch {
    await frame.click(sel, { timeout: 4000, force: true });
  }
}

// Trusted combobox: real click on the field, real keystrokes, then click the matching option.
async function trustedSelect(frame, id, wanted, search) {
  const sel = `[id="${id}"]`;
  if (!(await frame.locator(sel).count()))
    return { status: "not_found", got: "" };
  const page = frame.page();
  await clickField(frame, sel);
  await page.keyboard.type(search, { delay: 30 });
  const optionSel = ".select__option:visible";
  const rank = (text) => {
    const t = text.toLowerCase().replace(/\s+/g, " ").trim();
    const w = wanted.toLowerCase();
    if (t === w) return 0;
    if (t.startsWith(w)) return 1;
    if (
      ` ${t.replace(/[^a-z0-9]+/g, " ")} `.includes(
        ` ${w.replace(/[^a-z0-9]+/g, " ").trim()} `,
      )
    )
      return 2;
    if (t.includes(w)) return 3;
    return 9;
  };
  let picked = null;
  for (let i = 0; i < 60 && !picked; i++) {
    const texts = await frame
      .locator(optionSel)
      .allTextContents()
      .catch(() => []);
    const best = texts
      .map((t, idx) => [rank(t), idx])
      .filter(([r]) => r < 9)
      .sort((a, b) => a[0] - b[0])[0];
    if (best) {
      picked = texts[best[1]].trim();
      await frame.locator(optionSel).nth(best[1]).click({ timeout: 5000 });
    } else {
      await page.waitForTimeout(100);
    }
  }
  if (!picked) {
    const seen = await frame
      .locator(optionSel)
      .allTextContents()
      .catch(() => []);
    await page.keyboard.press("Escape");
    return {
      status: "no_option",
      got: "",
      detail: seen.slice(0, 4).join(" | ") || "no options",
    };
  }
  const got = await frame.evaluate((fid) => {
    const box = document.getElementById(fid)?.closest(".select__control");
    return (
      box
        ?.querySelector(".select__single-value, .select__multi-value__label")
        ?.textContent?.trim() ?? ""
    );
  }, id);
  const ok =
    got &&
    (got.toLowerCase().includes(wanted.toLowerCase()) || picked.includes(got));
  return { status: ok ? "ok" : "mismatch", got, detail: `picked "${picked}"` };
}

async function formFrame(page) {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames())
      if (
        await f
          .evaluate(() => !!document.getElementById("first_name"))
          .catch(() => false)
      )
        return f;
    await page.waitForTimeout(500);
  }
  return null;
}

const browser = await chromium.launch();
const tally = {};
const mark = (kind, ok) => {
  tally[kind] ??= [0, 0];
  tally[kind][1]++;
  if (ok) tally[kind][0]++;
};
try {
  for (const plan of PLANS) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.route("**/*", (r) =>
      r.request().method() === "GET" ? r.continue() : r.abort(),
    );
    await page.goto(plan.url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    if (plan.reveal) {
      const tab = page.getByText(plan.reveal, { exact: true }).first();
      if (await tab.count()) {
        await tab.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1500);
        console.log(`  revealed form via "${plan.reveal}"`);
      }
    }
    const frame = await formFrame(page);
    console.log(
      `\n=== ${plan.name} (${frame === page.mainFrame() ? "main page" : "iframe"})`,
    );
    await frame.evaluate(bundle);

    const countryFirst = plan.selects.find(([id]) => id === "country");
    if (countryFirst) {
      const r = await trustedSelect(frame, ...countryFirst);
      mark("select", r.status === "ok");
      console.log(
        `  ${r.status === "ok" ? "✓" : "✗"} select country (first)        got="${r.got}" ${r.status}${r.detail ? ` (${r.detail})` : ""}`,
      );
      plan.selects = plan.selects.filter(([id]) => id !== "country");
    }
    for (const [id, value] of Object.entries(plan.text)) {
      await clickField(frame, `[id="${id}"]`);
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText(value);
      const got = await frame.evaluate(
        (i) => document.getElementById(i)?.value ?? "",
        id,
      );
      mark("text", got === value);
    }
    console.log(`  text fields: ${tally.text[0]}/${tally.text[1]} so far`);

    for (const [id, wanted, search] of plan.selects) {
      const r = await trustedSelect(frame, id, wanted, search);
      mark("select", r.status === "ok");
      console.log(
        `  ${r.status === "ok" ? "✓" : "✗"} select ${id.padEnd(22)} want~"${wanted}" got="${r.got}" ${r.status}${r.detail ? ` (${r.detail})` : ""}`,
      );
    }

    if (plan.repeat) {
      const before = await frame.locator(`[id^="${plan.repeat}"]`).count();
      const btn = frame.getByRole("button", { name: /add another/i }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 8000 });
      }
      await page.waitForTimeout(500);
      const after = await frame.locator(`[id^="${plan.repeat}"]`).count();
      mark("repeater", after > before);
      console.log(
        `  ${after > before ? "✓" : "✗"} repeater ${plan.repeat} ${before}→${after}`,
      );
    }

    // Re-check text values after selects (before the resume attach).
    const textNow = await frame.evaluate(
      (ids) => ids.map((i) => [i, document.getElementById(i)?.value ?? null]),
      Object.keys(plan.text),
    );
    const lost = textNow.filter(([i, v]) => v !== plan.text[i]);
    console.log(
      `  text values intact before file attach: ${lost.length ? `NO, lost ${lost.map(([i]) => i).join(",")}` : "yes"}`,
    );

    if (plan.file) {
      await frame.locator(`[id="${plan.file}"]`).setInputFiles({
        name: "Test_Candidate_Resume.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n%%EOF"),
      });
      await page.waitForTimeout(2500);
      const textAfter = await frame.evaluate(
        (ids) => ids.map((i) => [i, document.getElementById(i)?.value ?? null]),
        Object.keys(plan.text),
      );
      const lostAfter = textAfter.filter(([i, v]) => v !== plan.text[i]);
      const uploadMsg = await frame
        .locator(
          "text=/error|failed|try again|uploaded|Test_Candidate_Resume/i",
        )
        .first()
        .textContent()
        .catch(() => null);
      console.log(
        `  file attached (upload POST blocked by spike). Page says: "${(uploadMsg || "").trim().slice(0, 60)}". Text intact after attach: ${lostAfter.length ? `NO, lost ${lostAfter.map(([i]) => i).join(",")}` : "yes"}`,
      );
    }
    const empty = await frame.evaluate(() =>
      globalThis.GHFill.emptyRequired(document),
    );
    console.log(`  required still empty: ${empty.join(", ") || "none"}`);
    await page.screenshot({
      path: path.join(here, `out2-${plan.name}.png`),
      fullPage: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("\n=== totals", JSON.stringify(tally));
