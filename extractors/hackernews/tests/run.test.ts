import { describe, expect, it, vi } from "vitest";
import {
  mapHackerNewsPost,
  matchesHnLocation,
  matchesWorkplace,
  runHackerNews,
} from "../src/run";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const POSTS = [
  {
    id: 101,
    created_at: "2026-11-01T15:00:00Z",
    text: 'Acme (YC W24) | Senior Backend Engineer, Data Engineer | REMOTE | $150k-$190k<p>We build payments infra in Go and Python. Apply at <a href="https://acme.dev/careers">https://acme.dev/careers</a>',
  },
  {
    id: 102,
    text: "Globex | Data Engineer | REMOTE (US only) | Full-time<p>Python, Spark.",
  },
  {
    id: 103,
    text: "Initech | Bengaluru, India | Onsite<p>Roles:<p>- Data Engineer (Python, Airflow)",
  },
  { id: 104, text: "I'm a data engineer looking for work | Remote<p>Python" },
];

const fetchFor = () =>
  vi.fn(async (url: string | URL | Request) =>
    String(url).includes("search_by_date")
      ? jsonResponse({
          hits: [
            { objectID: "9", title: "Ask HN: Who wants to be hired? (November 2026)" },
            { objectID: "10", title: "Ask HN: Who is hiring? (November 2026)" },
          ],
        })
      : jsonResponse({ children: POSTS }),
  ) as unknown as typeof fetch;

describe("Hacker News extractor", () => {
  it("maps a hiring post into a job titled with the role that fits the search", () => {
    expect(mapHackerNewsPost({ id: "101", text: POSTS[0]!.text }, "data engineer")).toEqual(
      expect.objectContaining({
        source: "hackernews",
        sourceJobId: "101",
        employer: "Acme",
        title: "Data Engineer",
        jobUrl: "https://news.ycombinator.com/item?id=101",
        applicationLink: "https://acme.dev/careers",
        location: "REMOTE",
        isRemote: true,
      }),
    );
  });

  it("takes the role from the post's body when the header names none", () => {
    expect(mapHackerNewsPost({ id: "103", text: POSTS[2]!.text }, "data engineer")).toMatchObject({
      employer: "Initech",
      title: "Data Engineer (Python, Airflow)",
      location: "Bengaluru, India · Onsite",
    });
  });

  it("skips people looking for work", () => {
    expect(mapHackerNewsPost({ id: "104", text: POSTS[3]!.text }, "data engineer")).toBeNull();
  });

  it("keeps posts in the country, worldwide, or remote without a region limit", () => {
    expect(matchesHnLocation("Initech | Bengaluru, India | Onsite", "india")).toBe(true);
    expect(matchesHnLocation("Acme | Engineer | REMOTE", "india")).toBe(true);
    expect(matchesHnLocation("Globex | Engineer | REMOTE (US only)", "india")).toBe(false);
    expect(matchesHnLocation("Hooli | Engineer | San Francisco, CA", "india")).toBe(false);
    expect(matchesHnLocation("Hooli | Engineer | San Francisco, CA", undefined)).toBe(true);
  });

  it("follows the chosen workplace types", () => {
    expect(matchesWorkplace("Acme | REMOTE", ["remote"])).toBe(true);
    expect(matchesWorkplace("Acme | REMOTE", ["onsite"])).toBe(false);
    expect(matchesWorkplace("Acme | Berlin | Hybrid", ["remote"])).toBe(false);
    expect(matchesWorkplace("Acme | Remote or Hybrid in Berlin", ["hybrid"])).toBe(true);
  });

  it("reads this month's thread once and keeps the posts that fit", async () => {
    const fetchImpl = fetchFor();
    const result = await runHackerNews({
      searchTerms: ["data engineer", "python"],
      selectedCountry: "india",
      fetchImpl,
    });
    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["101", "103"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetchImpl).mock.calls[1]?.[0])).toBe(
      "https://hn.algolia.com/api/v1/items/10",
    );
  });

  it("reports a failed request without throwing", async () => {
    const result = await runHackerNews({
      fetchImpl: vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch,
    });
    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Hacker News request failed with status 503",
    });
  });
});
