import { format, parse } from "date-fns";
import type { BankKind } from "../bank/catalogue.js";
import { parseMoney } from "../bank/normalize.js";
import { currencyOf } from "./country.js";
import type { FormField } from "./gh-schema.js";

/**
 * Turns a stored answer (one canonical format per kind) into what this particular question
 * asks for: "30 days" vs "30", LPA vs a plain amount, DD/MM/YYYY vs ISO. For selects it also
 * offers equivalent phrasings ("1 month" for 30 days) to match against the form's choices.
 */

export type Formatted =
  | { readonly value: string; readonly alternatives: readonly string[] }
  | { readonly needsYou: string };

const plain = (value: string): Formatted => ({ value, alternatives: [] });

const trimNumber = (n: number) => String(Number(n.toFixed(2)));

function formatDays(stored: string, field: FormField): Formatted {
  const days = Number(stored);
  if (!Number.isFinite(days)) return plain(stored);
  const label = field.label.toLowerCase();
  if (field.type === "select" || field.type === "multiselect") {
    if (days === 0)
      return {
        value: "Immediate",
        alternatives: ["Immediately", "0 days", "Less than 15 days"],
      };
    const alternatives = [
      ...(days % 30 === 0
        ? [days === 30 ? "1 month" : `${days / 30} months`]
        : []),
      ...(days % 7 === 0 ? [`${days / 7} weeks`] : []),
      String(days),
    ];
    return { value: `${days} days`, alternatives };
  }
  if (/\b(in days|days\)|\(days|no\.? of days|number of days)\b/.test(label))
    return plain(String(days));
  if (days === 0) return plain("Immediate");
  return plain(`${days} days`);
}

const CURRENCY_IN_LABEL = /\b(inr|eur|usd|gbp|sgd|jpy|sek|dkk|chf)\b|[₹€$£]/i;

function formatMoney(
  stored: string,
  field: FormField,
  jobCountry: string | null,
): Formatted {
  const money = parseMoney(stored);
  if (!money) return plain(stored);
  const jobCurrency = currencyOf(jobCountry);
  if (jobCurrency && jobCurrency !== money.currency)
    return {
      needsYou: `Your saved amount is in ${money.currency}; this job is in ${jobCountry} (${jobCurrency})`,
    };
  const label = field.label.toLowerCase();
  if (/\b(lpa|lakhs?|lacs?)\b/.test(label))
    return plain(trimNumber(money.amount / 100_000));
  if (/\b(in thousands|'000|000s)\b|\(k\)/.test(label))
    return plain(trimNumber(money.amount / 1_000));
  if (CURRENCY_IN_LABEL.test(label) || /\bctc\b/.test(label))
    return plain(String(money.amount));
  return plain(`${money.amount} ${money.currency} per year`);
}

function formatDate(stored: string, field: FormField): Formatted {
  const date = parse(stored, "yyyy-MM-dd", new Date(2000, 0, 1));
  if (Number.isNaN(date.getTime())) return plain(stored);
  const label = field.label.toLowerCase();
  if (label.includes("dd/mm/yyyy")) return plain(format(date, "dd/MM/yyyy"));
  if (label.includes("mm/dd/yyyy")) return plain(format(date, "MM/dd/yyyy"));
  return plain(stored);
}

export function formatBankValue(
  kind: BankKind,
  stored: string,
  field: FormField,
  jobCountry: string | null,
): Formatted {
  switch (kind) {
    case "days":
      return formatDays(stored, field);
    case "money":
      return formatMoney(stored, field, jobCountry);
    case "date":
      return formatDate(stored, field);
    default:
      return plain(stored);
  }
}
