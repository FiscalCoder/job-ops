/**
 * The answer-bank keys the planner knows how to use. Values live in the `answer_bank` table;
 * this list gives each key a label, a group for the editor page, and whether it is protected.
 * Protected keys are only ever filled from your saved value: no model, no default, no guess.
 */

export type BankKind = "text" | "yesno" | "list";

export interface BankKeyDef {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly kind: BankKind;
  readonly protected: boolean;
  readonly hint?: string;
}

const def = (
  key: string,
  label: string,
  group: string,
  kind: BankKind,
  options: { protected?: boolean; hint?: string } = {},
): BankKeyDef => ({
  key,
  label,
  group,
  kind,
  protected: options.protected ?? false,
  ...(options.hint ? { hint: options.hint } : {}),
});

export const BANK_KEYS: readonly BankKeyDef[] = [
  def("identity.first_name", "First name", "Identity", "text"),
  def("identity.last_name", "Last name", "Identity", "text", {
    hint: "Your initial is fine; forms only need something here.",
  }),
  def("identity.preferred_name", "Preferred first name", "Identity", "text", {
    hint: "Left empty, your first name is used.",
  }),
  def("identity.date_of_birth", "Date of birth", "Identity", "text", {
    protected: true,
    hint: "YYYY-MM-DD. Only used when a form requires it.",
  }),
  def("location.current_city", "Current city", "Location", "text", {
    hint: "Used for 'where are you based' questions; it is never put on your resume.",
  }),
  def("location.state", "State / region", "Location", "text"),
  def("location.current_country", "Current country", "Location", "text"),
  def(
    "work.authorized_countries",
    "Countries you can work in without sponsorship",
    "Work authorisation",
    "list",
    {
      protected: true,
      hint: "Comma-separated, e.g. India. Authorisation and sponsorship questions are answered from this and the job's country.",
    },
  ),
  def("work.notice_period", "Notice period", "Work authorisation", "text", {
    protected: true,
    hint: "e.g. 30 days",
  }),
  def("work.relocation", "Willing to relocate", "Work authorisation", "yesno"),
  def(
    "work.earliest_start_date",
    "Earliest start date",
    "Work authorisation",
    "text",
  ),
  def(
    "work.preferred_cities",
    "Cities you can work in",
    "Work authorisation",
    "list",
    {
      hint: "Comma-separated; used for 'which cities are you available to work in'.",
    },
  ),
  def("comp.current", "Current compensation", "Compensation", "text", {
    protected: true,
  }),
  def("comp.expected", "Expected compensation", "Compensation", "text", {
    protected: true,
  }),
  def(
    "history.worked_at_company",
    "Have you worked at the company you're applying to?",
    "History",
    "yesno",
    {
      hint: "Usually No; you can change it on a single application.",
    },
  ),
  def(
    "profile.years_experience",
    "Years of professional experience",
    "Profile",
    "text",
  ),
  def("profile.languages", "Languages you speak fluently", "Profile", "list"),
  def("misc.heard_about", "How did you hear about us", "Other", "text", {
    hint: "e.g. LinkedIn",
  }),
  def("eeo.gender", "Gender (EEO)", "Voluntary disclosures", "text", {
    hint: "Left empty, the form's 'decline to answer' choice is proposed for your click.",
  }),
  def("eeo.race", "Race / ethnicity (EEO)", "Voluntary disclosures", "text"),
  def("eeo.veteran", "Veteran status (EEO)", "Voluntary disclosures", "text"),
  def(
    "eeo.disability",
    "Disability status (EEO)",
    "Voluntary disclosures",
    "text",
  ),
  def("eeo.pronouns", "Pronouns", "Voluntary disclosures", "text"),
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
