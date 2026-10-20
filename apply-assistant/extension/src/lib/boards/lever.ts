import { type BoardApi, getJson, getText } from "./types";

/**
 * Lever: the public postings API for listings and liveness; the form is the <form> of the
 * posting's apply page (Lever has no form API), which the server parses.
 */

export const LEVER_API = "https://api.lever.co/v0/postings";

interface LeverPosting {
  id?: unknown;
  text?: unknown;
  hostedUrl?: unknown;
  descriptionPlain?: unknown;
  categories?: { location?: unknown } | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const site = (token: string) => `${LEVER_API}/${encodeURIComponent(token)}`;

const posting = async (
  deps: Parameters<BoardApi["verify"]>[0],
  token: string,
  postingId: string,
) =>
  (await getJson(
    deps,
    `${site(token)}/${encodeURIComponent(postingId)}?mode=json`,
  )) as LeverPosting | null;

/** The application form section of an apply page (the rest is scripts and styles). */
export function applicationForm(html: string): string | null {
  const start = html.search(/<form\b[^>]*id="application-form"/);
  if (start < 0) return null;
  const end = html.indexOf("</form>", start);
  return end < 0 ? null : html.slice(start, end + "</form>".length);
}

export const lever: BoardApi = {
  ats: "lever",

  async exists(deps, token) {
    return Array.isArray(
      await getJson(deps, `${site(token)}?mode=json&limit=1`),
    );
  },

  async list(deps, token) {
    const jobs = (await getJson(deps, `${site(token)}?mode=json`)) as
      | LeverPosting[]
      | null;
    if (!Array.isArray(jobs)) return null;
    const open = jobs.filter((j) => text(j.id));
    return {
      jobs: open.map((j) => ({
        id: text(j.id),
        title: text(j.text),
        location: text(j.categories?.location),
        url: text(j.hostedUrl),
      })),
      descriptions: Object.fromEntries(
        open.map((j) => [
          text(j.id),
          text(j.descriptionPlain).slice(0, 150_000),
        ]),
      ),
    };
  },

  async describe(_deps, _token, ids, listing) {
    return Object.fromEntries(
      ids.flatMap((id) => {
        const description = listing.descriptions?.[id];
        return description ? [[id, description]] : [];
      }),
    );
  },

  async verify(deps, token, postingId) {
    const found = await posting(deps, token, postingId);
    return {
      live: found !== null,
      url:
        text(found?.hostedUrl) || `https://jobs.lever.co/${token}/${postingId}`,
    };
  },

  async form(deps, token, postingId) {
    const found = await posting(deps, token, postingId);
    if (!found) return null;
    const page = await getText(
      deps,
      `https://jobs.lever.co/${encodeURIComponent(token)}/${encodeURIComponent(postingId)}/apply`,
    );
    const formHtml = page ? applicationForm(page) : null;
    if (!formHtml) return null;
    return {
      id: postingId,
      title: text(found.text),
      location: text(found.categories?.location),
      formHtml,
    };
  },
};
