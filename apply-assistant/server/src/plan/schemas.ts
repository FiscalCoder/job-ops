import type { Ats } from "../ats.js";
import { parseAshbySchema } from "./ashby-schema.js";
import type { FormSchema } from "./form-schema.js";
import { parseGreenhouseSchema } from "./gh-schema.js";

/** Parses a fetched form definition with the parser for its application system. */
export function parseFormSchema(ats: Ats, payload: unknown): FormSchema {
  switch (ats) {
    case "greenhouse":
      return parseGreenhouseSchema(payload);
    case "ashby":
      return parseAshbySchema(payload);
  }
}
