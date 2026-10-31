import { sameName } from "./history-blocks.js";

/**
 * Your employers' office addresses, kept in the answer bank as one line per employer:
 * "Company | Street | City | State | PIN | Country". Forms that ask where each job was (iCIMS's
 * work history) get these; your own address never goes there.
 */

export const EMPLOYER_ADDRESSES_KEY = "history.employer_addresses";

export interface EmployerAddress {
  readonly company: string;
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
}

export function parseEmployerAddresses(text: string): EmployerAddress[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter(([company]) => company)
    .map(([company = "", street = "", city = "", state = "", postalCode = "", country = ""]) => ({
      company,
      street,
      city,
      state,
      postalCode,
      country,
    }));
}

/** The saved address of the employer with this name, if any. */
export function employerAddress(
  saved: string | undefined,
  company: string,
): EmployerAddress | null {
  if (!saved?.trim()) return null;
  return (
    parseEmployerAddresses(saved).find((a) => sameName(a.company, company)) ??
    null
  );
}
