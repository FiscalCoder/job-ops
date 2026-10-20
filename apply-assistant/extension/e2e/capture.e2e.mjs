// LinkedIn apply-link capture in a real Chrome with the built extension. The browser resolves
// EVERY hostname to a local HTTPS stub (host-resolver-rules), so nothing can reach LinkedIn,
// the redirector, the ATS or apply-assistant: nothing real is read or written.
//   node e2e/capture.e2e.mjs        (needs openssl on PATH for the throwaway certificate)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionDir = fileURLToPath(
  new URL("../.output/chrome-mv3", import.meta.url),
);
const JOB_ID = "4400000001";
const COMPANY = "https://job-boards.greenhouse.io/acme/jobs/77?gh_src=x";
const REDIRECT = `https://click.example.com/t/abc?to=${encodeURIComponent(COMPANY)}`;
const EXTERNAL = `https://www.linkedin.com/jobs/view/externalApply/${JOB_ID}?url=${encodeURIComponent(REDIRECT)}&urlHash=h`;

const work = mkdtempSync(path.join(tmpdir(), "capture-"));
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

const captured = [];
const seen = [];
const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
const server = https.createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (req, res) => {
    const host = req.headers.host ?? "";
    const url = new URL(req.url ?? "/", `https://${host}`);
    seen.push(`${req.method} ${host}${url.pathname}`);
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    if (host === "apply.hueint.com" && url.pathname === "/captures") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        captured.push(JSON.parse(body));
        send(
          200,
          "application/json",
          JSON.stringify({
            ok: true,
            data: {
              status: "saved",
              jobId: "j1",
              title: "Engineer",
              employer: "Acme",
              link: COMPANY,
            },
          }),
        );
      });
      return;
    }
    if (
      host === "www.linkedin.com" &&
      url.pathname.startsWith("/jobs/view/externalApply")
    )
      return send(302, "text/plain", "", {
        location: url.searchParams.get("url"),
      });
    if (host === "www.linkedin.com")
      return send(
        200,
        "text/html",
        page(
          `<h1>Job</h1><button id="apply" onclick="window.open('${EXTERNAL}', '_blank')">Apply</button>`,
        ),
      );
    if (host === "click.example.com")
      return send(
        200,
        "text/html",
        page(`<script>location.replace(${JSON.stringify(COMPANY)})</script>`),
      );
    if (host === "job-boards.greenhouse.io")
      return send(200, "text/html", page("<h1>Acme · Engineer</h1>"));
    send(404, "text/plain", "stub: not found");
  },
);
await new Promise((resolve) => server.listen(443, "127.0.0.1", resolve));

const context = await chromium.launchPersistentContext(
  path.join(work, "profile"),
  {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--host-resolver-rules=MAP * 127.0.0.1",
      "--ignore-certificate-errors",
    ],
  },
);

let ok = false;
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() =>
    chrome.storage.local.set({
      serverUrl: "https://apply.hueint.com",
      token: "test-token",
    }),
  );

  const linkedin = await context.newPage();
  // LinkedIn's job list is a single-page app: the job id arrives via history updates.
  await linkedin.goto("https://www.linkedin.com/jobs/search/?keywords=x");
  await linkedin.evaluate(
    (id) => history.pushState({}, "", `/jobs/search/?currentJobId=${id}`),
    JOB_ID,
  );
  const opened = context.waitForEvent("page");
  await linkedin.click("#apply");
  const company = await opened;
  await company.waitForURL(/greenhouse/, { timeout: 10_000 });

  const deadline = Date.now() + 15_000;
  while (captured.length === 0 && Date.now() < deadline)
    await linkedin.waitForTimeout(250);
  const stored = await worker.evaluate(() =>
    chrome.storage.local.get("captures"),
  );

  ok =
    captured.length === 1 &&
    captured[0].linkedinJobId === JOB_ID &&
    captured[0].applyUrl.startsWith("https://click.example.com/") &&
    captured[0].finalUrl === COMPANY &&
    stored.captures?.[0]?.outcome?.status === "saved";
  console.log(
    JSON.stringify(
      { ok, captured, stored: stored.captures?.length ?? 0, seen },
      null,
      1,
    ),
  );
} finally {
  await context.close();
  server.close();
  rmSync(work, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
process.exit(ok ? 0 : 1);
