/**
 * A job's page as text for Job Ops' manual import, read the way Job Ops' own "fetch from link"
 * reads it (title, Open Graph and meta data, then the main content). Runs inside the page, so
 * it stays self-contained, and works on a copy: the page you see isn't changed.
 */
export function readJobText(): string {
  const meta = (selector: string) =>
    document.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
  const pageTitle = document.title.trim();
  const ogTitle = meta('meta[property="og:title"]');
  const ogSite = meta('meta[property="og:site_name"], meta[property="og:site-name"]');
  const ogDescription = meta('meta[property="og:description"]');
  const description = meta('meta[name="description"]');

  const copy = document.body.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(
    "script, style, nav, header, footer, aside, iframe, noscript, svg, " +
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
      ".nav, .navbar, .header, .footer, .sidebar, .menu, .cookie, .popup, .modal, .ad, .advertisement",
  ))
    el.remove();
  const main =
    copy.querySelector(
      'main, [role="main"], article, ' +
        ".job-description, .job-details, .job-content, .vacancy-description, " +
        "#job-description, #job-details, #job-content, " +
        '[class*="job-desc"], [class*="jobDesc"], [class*="vacancy"], [class*="posting"]',
    ) ?? copy;
  // A copy has no layout, so its text runs blocks together: a line break after each block.
  for (const block of main.querySelectorAll(
    "p, div, li, h1, h2, h3, h4, h5, h6, br, tr, section, article, ul, ol, dd, dt",
  ))
    block.append("\n");
  const text = (main.textContent ?? "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const head = [
    pageTitle && `Page Title: ${pageTitle}`,
    ogTitle && ogTitle !== pageTitle && `Job Title: ${ogTitle}`,
    ogSite && `Company/Site: ${ogSite}`,
    ogDescription && `Summary: ${ogDescription}`,
    description && description !== ogDescription && `Description: ${description}`,
  ].filter(Boolean);
  const full = head.length ? `${head.join("\n")}\n\n---\n\n${text}` : text;
  return full.slice(0, 50_000);
}
