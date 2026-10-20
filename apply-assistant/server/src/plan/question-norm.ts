/**
 * The same question across forms: "How did you hear about GitLab?" and "How did you hear about
 * ElevenLabs?" are one question once the company's name is set aside. Used to remember the
 * answers you give and reuse them on the next form.
 */

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function normalizeQuestion(label: string, employer = ""): string {
  let text = label.toLowerCase().replace(/[‘’`]/g, "'");
  const company = employer.trim().toLowerCase();
  if (company.length >= 2)
    text = text.replace(new RegExp(escapeRegExp(company), "g"), " {company} ");
  return text
    .replace(/\(required\)|\*/g, " ")
    .replace(/[^a-z0-9{}' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
