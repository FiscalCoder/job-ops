import { pageBlock } from "../kit/page-fill";
import { CONFIRMATION_PATH, CONFIRMATION_TEXT } from "./job-match";

/**
 * Does the tab show an application's confirmation ("Thank you for applying", /confirmation)?
 * Only on sites the extension may read, never LinkedIn; null when it can't look.
 */
export async function looksSubmitted(
  tab: chrome.tabs.Tab,
): Promise<boolean | null> {
  if (tab.id === undefined || (await pageBlock(tab)) !== null) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        path: `${location.pathname}${location.search}`,
        text: (document.body?.innerText ?? "").slice(0, 20_000),
      }),
    });
    const page = result?.result;
    if (!page) return null;
    return (
      CONFIRMATION_PATH.test(page.path) || CONFIRMATION_TEXT.test(page.text)
    );
  } catch {
    return null;
  }
}
