import {
  GREENHOUSE_BOARDS_API_ORIGIN,
  getJobDetails,
  getJobsFromBoard,
} from "@career-boards/greenhouse";
import { type BoardApi, getJson } from "./types";

/** Greenhouse's public Job Board API (read through upstream's career-boards package). */

/** At most this many postings' descriptions are fetched to pick the match. */
const MAX_DETAILS = 8;
export const GREENHOUSE_API = `${GREENHOUSE_BOARDS_API_ORIGIN}/v1/boards`;

const posting = (token: string, id: string) =>
  `${GREENHOUSE_API}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}`;

export const greenhouse: BoardApi = {
  ats: "greenhouse",

  async exists(deps, token) {
    return (
      (await getJson(
        deps,
        `${GREENHOUSE_API}/${encodeURIComponent(token)}`,
      )) !== null
    );
  },

  async list(deps, token) {
    try {
      await deps.pause();
      const { jobs } = await getJobsFromBoard({
        careersUrl: `https://job-boards.greenhouse.io/${token}`,
        fetchImpl: deps.fetch,
      });
      return {
        jobs: jobs.map((j) => ({
          id: j.externalId,
          title: j.title,
          location: j.locationText ?? "",
          url: j.jobUrl,
        })),
      };
    } catch {
      return null;
    }
  },

  async describe(deps, token, ids) {
    const details: Record<string, string> = {};
    for (const id of ids.slice(0, MAX_DETAILS)) {
      try {
        await deps.pause();
        const { job } = await getJobDetails({
          jobRef: posting(token, id),
          fetchImpl: deps.fetch,
        });
        details[id] = job.jobDescriptionHtml.slice(0, 150_000);
      } catch {
        /* a posting that vanished mid-lookup is simply left out */
      }
    }
    return details;
  },

  async verify(deps, token, postingId) {
    const found = (await getJson(deps, posting(token, postingId))) as {
      absolute_url?: unknown;
    } | null;
    return {
      live: found !== null,
      url:
        typeof found?.absolute_url === "string"
          ? found.absolute_url
          : `https://job-boards.greenhouse.io/${token}/jobs/${postingId}`,
    };
  },

  form(deps, token, postingId) {
    return getJson(deps, `${posting(token, postingId)}?questions=true`);
  },
};
