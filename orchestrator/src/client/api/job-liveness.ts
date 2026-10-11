import { fetchApi } from "./core";

interface ExpireJobsResponse {
  requested: number;
  succeeded: number;
  failed: number;
  results: Array<{ jobId: string; ok: boolean; message?: string }>;
}

/** Mark one or more discovered/ready jobs as expired. */
export async function expireJobs(
  jobIds: string[],
): Promise<ExpireJobsResponse> {
  return fetchApi<ExpireJobsResponse>("/jobs/liveness/expire", {
    method: "POST",
    body: JSON.stringify({ jobIds }),
  });
}
