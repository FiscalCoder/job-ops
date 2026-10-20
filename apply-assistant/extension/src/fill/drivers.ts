import type { Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { Ats } from "../lib/boards/types";
import { AshbyDriver, ashbyFormUrl } from "./ashby-driver";
import { GreenhouseDriver } from "./driver";
import type { FormDriver } from "./trusted";

/** Which page to open, and which driver fills it, for each application system. */

export function formUrlFor(ats: Ats, postingUrl: string): string {
  return ats === "ashby" ? ashbyFormUrl(postingUrl) : postingUrl;
}

export function attachDriver(ats: Ats, page: Page): Promise<FormDriver | null> {
  switch (ats) {
    case "greenhouse":
      return GreenhouseDriver.attach(page);
    case "ashby":
      return AshbyDriver.attach(page);
  }
}
