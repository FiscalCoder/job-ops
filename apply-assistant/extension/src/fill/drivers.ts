import type { Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { Ats } from "../lib/boards/types";
import { AshbyDriver, ashbyFormUrl } from "./ashby-driver";
import { GreenhouseDriver } from "./driver";
import { LeverDriver, leverFormUrl } from "./lever-driver";
import type { FormDriver } from "./trusted";

/** Which page to open, and which driver fills it, for each application system. */

export function formUrlFor(ats: Ats, postingUrl: string): string {
  switch (ats) {
    case "greenhouse":
      return postingUrl;
    case "ashby":
      return ashbyFormUrl(postingUrl);
    case "lever":
      return leverFormUrl(postingUrl);
  }
}

/** Lever fills fields from an attached resume, so there the resume goes first. */
export const resumeFirst = (ats: Ats): boolean => ats === "lever";

export function attachDriver(ats: Ats, page: Page): Promise<FormDriver | null> {
  switch (ats) {
    case "greenhouse":
      return GreenhouseDriver.attach(page);
    case "ashby":
      return AshbyDriver.attach(page);
    case "lever":
      return LeverDriver.attach(page);
  }
}
