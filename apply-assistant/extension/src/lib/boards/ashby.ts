import { type BoardApi, type BoardListing, getJson } from "./types";

/**
 * Ashby: the public posting API for listings, and the read-only `ApiJobPosting` query that
 * Ashby's own application page runs for the form definition.
 */

export const ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board";
export const ASHBY_GRAPHQL =
  "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting";

const FORM_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title isListed locationName
    applicationForm { id sections { title fieldEntries { ... on FormFieldEntry { id field isRequired isHidden } } } }
  }
}`;

interface AshbyJob {
  id?: unknown;
  title?: unknown;
  location?: unknown;
  jobUrl?: unknown;
  isListed?: unknown;
  descriptionPlain?: unknown;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const board = (token: string) => `${ASHBY_API}/${encodeURIComponent(token)}`;

async function listed(
  deps: Parameters<BoardApi["list"]>[0],
  token: string,
): Promise<AshbyJob[] | null> {
  const data = (await getJson(deps, board(token))) as { jobs?: unknown } | null;
  return Array.isArray(data?.jobs) ? (data.jobs as AshbyJob[]) : null;
}

export const ashby: BoardApi = {
  ats: "ashby",

  async exists(deps, token) {
    return (await listed(deps, token)) !== null;
  },

  async list(deps, token): Promise<BoardListing | null> {
    const jobs = await listed(deps, token);
    if (!jobs) return null;
    const open = jobs.filter((j) => j.isListed !== false && text(j.id));
    return {
      jobs: open.map((j) => ({
        id: text(j.id),
        title: text(j.title),
        location: text(j.location),
        url: text(j.jobUrl),
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
    const jobs = (await listed(deps, token)) ?? [];
    const found = jobs.find((j) => text(j.id) === postingId);
    return {
      live: found !== undefined && found.isListed !== false,
      url:
        text(found?.jobUrl) || `https://jobs.ashbyhq.com/${token}/${postingId}`,
    };
  },

  async form(deps, token, postingId) {
    const data = (await getJson(deps, ASHBY_GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "ApiJobPosting",
        variables: {
          organizationHostedJobsPageName: token,
          jobPostingId: postingId,
        },
        query: FORM_QUERY,
      }),
    })) as { data?: { jobPosting?: unknown } } | null;
    return data?.data?.jobPosting ? data.data : null;
  },
};
