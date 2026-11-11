/**
 * Fields Claude's takeover (working the page from screenshots) isn't sent to, because it almost
 * never helps there and only costs time and money (traces, 2026-10/11: 306 takeovers, 26%
 * finished):
 * - location fields (city, state, country, address, PIN): 94 takeovers, 14% finished, about
 *   two-fifths of takeover cost. Your answers there are fixed; plain code fills them or you do.
 *   A phone number's country code isn't one of these (it finished 44%).
 * - a field that isn't on the page: there's nothing for Claude to work.
 */

const LOCATION =
  /\b(city|town|state|province|county|country|location|address|street|pin ?code|zip ?code|zip|postal ?code|postcode|district|locality)\b/i;
const PHONE_CODE = /\b(phone|mobile|calling|dial(ling)?|telephone)\b|country code/i;
const NOT_FOUND = /field not found on the page/i;

/** Why the takeover is skipped for this field; null when Claude may take it over. */
export function takeoverSkipped(label: string, failure: string): string | null {
  if (NOT_FOUND.test(failure)) return "the field isn't on the page, so there's nothing for Claude to work";
  if (LOCATION.test(label) && !PHONE_CODE.test(label))
    return "location fields come from your saved answers; Claude's takeover rarely sets them";
  return null;
}
