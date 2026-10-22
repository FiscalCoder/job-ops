/**
 * The answer-bank keys the planner knows how to use. Values live in the `answer_bank` table;
 * this list gives each key a label, a group for the editor page, its format (kind + example),
 * and whether it is protected. Protected keys are only ever filled from your saved value:
 * no model, no default, no guess.
 */

/**
 * text   free text
 * yesno  "Yes" / "No"
 * list   comma-separated values
 * date   YYYY-MM-DD
 * days   whole number of days
 * number whole number
 * money  "<CUR> <amount>", yearly, e.g. "INR 3000000"
 */
export type BankKind =
  | "text"
  | "yesno"
  | "list"
  | "date"
  | "days"
  | "number"
  | "money";

export interface BankKeyDef {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly kind: BankKind;
  readonly protected: boolean;
  readonly example: string;
  readonly hint?: string;
}

const def = (
  key: string,
  label: string,
  group: string,
  kind: BankKind,
  example: string,
  options: { protected?: boolean; hint?: string } = {},
): BankKeyDef => ({
  key,
  label,
  group,
  kind,
  example,
  protected: options.protected ?? false,
  ...(options.hint ? { hint: options.hint } : {}),
});

export const BANK_KEYS: readonly BankKeyDef[] = [
  def("identity.first_name", "First name", "Identity", "text", "Priya"),
  def("identity.last_name", "Last name", "Identity", "text", "S", {
    hint: "An initial is fine; forms only need something here.",
  }),
  def(
    "identity.preferred_name",
    "Preferred first name",
    "Identity",
    "text",
    "Priya",
    {
      hint: "Left empty, your first name is used.",
    },
  ),
  def(
    "identity.date_of_birth",
    "Date of birth",
    "Identity",
    "date",
    "1995-04-23",
    {
      protected: true,
      hint: "Only used when a form requires it.",
    },
  ),
  def("location.current_city", "Current city", "Location", "text", "Chennai", {
    hint: "For 'where are you based' questions; never put on your resume.",
  }),
  def("location.state", "State / region", "Location", "text", "Tamil Nadu"),
  def(
    "location.address_line1",
    "Street address (line 1)",
    "Location",
    "text",
    "12 Main Road, Adyar",
    { hint: "For forms that ask for your address; never put on your resume." },
  ),
  def("location.postal_code", "Postal / PIN code", "Location", "text", "600020"),
  def(
    "location.current_country",
    "Current country",
    "Location",
    "text",
    "India",
    {
      hint: "Full country name.",
    },
  ),
  def(
    "work.authorized_countries",
    "Countries you can work in without sponsorship",
    "Work authorisation",
    "list",
    "India",
    {
      protected: true,
      hint: "Comma-separated full names. Authorisation and sponsorship questions are answered from this and the job's country.",
    },
  ),
  def(
    "work.notice_period",
    "Notice period (days)",
    "Work authorisation",
    "days",
    "30",
    {
      protected: true,
      hint: "Whole days. 0 = can join immediately. Matched to choices like '1 month' when a form offers them.",
    },
  ),
  def(
    "work.relocation",
    "Willing to relocate",
    "Work authorisation",
    "yesno",
    "Yes",
  ),
  def(
    "work.earliest_start_date",
    "Earliest start date",
    "Work authorisation",
    "date",
    "2026-12-01",
  ),
  def(
    "work.preferred_cities",
    "Cities you can work in",
    "Work authorisation",
    "list",
    "Chennai, Bengaluru, Remote",
    { hint: "For 'which cities are you available to work in'." },
  ),
  def(
    "comp.current",
    "Current compensation (yearly)",
    "Compensation",
    "money",
    "INR 3000000",
    {
      protected: true,
      hint: "Currency code + yearly amount. '30 LPA' or '₹30,00,000' also work. Shown in LPA when a form asks for LPA.",
    },
  ),
  def(
    "comp.expected",
    "Expected compensation (yearly)",
    "Compensation",
    "money",
    "INR 4000000",
    {
      protected: true,
      hint: "Only used for jobs paid in this currency; for other countries the form asks you.",
    },
  ),
  def(
    "history.worked_at_company",
    "Have you worked at the company you're applying to?",
    "History",
    "yesno",
    "No",
    { hint: "Usually No; you can change it on a single application." },
  ),
  def(
    "history.restrictive_covenants",
    "Bound by a non-compete or other restrictive covenant?",
    "History",
    "yesno",
    "No",
  ),
  def(
    "profile.years_experience",
    "Years of professional experience",
    "Profile",
    "number",
    "6",
  ),
  def(
    "profile.languages",
    "Languages you speak fluently",
    "Profile",
    "list",
    "English, Tamil",
  ),
  def(
    "profile.github",
    "GitHub or code samples (when your resume has no GitHub link)",
    "Profile",
    "text",
    "My repositories are private",
  ),
  def(
    "misc.heard_about",
    "How did you hear about us",
    "Other",
    "text",
    "LinkedIn",
  ),
  def("eeo.gender", "Gender (EEO)", "Voluntary disclosures", "text", "Male", {
    hint: "Left empty, the form's 'decline to answer' choice is proposed for your click.",
  }),
  def(
    "eeo.race",
    "Race / ethnicity (EEO)",
    "Voluntary disclosures",
    "text",
    "Asian",
  ),
  def(
    "eeo.veteran",
    "Veteran status (EEO)",
    "Voluntary disclosures",
    "text",
    "I am not a protected veteran",
  ),
  def(
    "eeo.disability",
    "Disability status (EEO)",
    "Voluntary disclosures",
    "text",
    "No, I don't have a disability",
  ),
  def("eeo.pronouns", "Pronouns", "Voluntary disclosures", "text", "he/him"),
];

const BY_KEY = new Map(BANK_KEYS.map((k) => [k.key, k]));

export const bankKeyDef = (key: string): BankKeyDef | undefined =>
  BY_KEY.get(key);

export const isProtectedKey = (key: string): boolean =>
  BY_KEY.get(key)?.protected === true;

/** List entries are stored as one comma- or newline-separated string. */
export const splitList = (value: string): string[] =>
  value
    .split(/[,\n;]/)
    .map((v) => v.trim())
    .filter(Boolean);
