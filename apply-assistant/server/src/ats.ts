/** The application systems (ATS) apply-assistant can look up, plan and fill. */

export const ATS_LIST = ["greenhouse", "ashby", "lever"] as const;
export type Ats = (typeof ATS_LIST)[number];

export const ATS_NAMES: Record<Ats, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
};
