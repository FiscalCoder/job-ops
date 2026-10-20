import { describe, expect, it } from "vitest";
import { ApplyClient } from "../src/lib/api";
import {
  type LookupResult,
  type PendingLookup,
  runTask,
  slugGuesses,
} from "../src/lib/lookups";
import { runLookups } from "../src/lib/worker";

const API = "https://boards-api.greenhouse.io/v1/boards";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A tiny fake internet: exact URL → response. Unknown URLs are 404s. */
function fakeWeb(
  routes: Record<string, () => Response>,
  redirects: Record<string, string> = {},
) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (redirects[url]) {
      const target = redirects[url];
      const res = routes[target]?.() ?? new Response("", { status: 200 });
      Object.defineProperty(res, "url", { value: target });
      return res;
    }
    const res = routes[url]?.() ?? new Response("not found", { status: 404 });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const board = {
  [`${API}/acme`]: () => json({ name: "Acme" }),
  [`${API}/acme/jobs`]: () =>
    json({
      jobs: [
        {
          id: 11,
          title: "Senior Backend Engineer",
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/11",
          location: { name: "Bengaluru" },
        },
        {
          id: 12,
          title: "Designer",
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/12",
          location: { name: "Remote" },
        },
      ],
      meta: { total: 2 },
    }),
  [`${API}/acme/jobs/11`]: () =>
    json({
      id: 11,
      title: "Senior Backend Engineer",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/11",
      content: "&lt;p&gt;Build APIs&lt;/p&gt;",
    }),
  [`${API}/acme/jobs/11?questions=true`]: () =>
    json({ id: 11, title: "Senior Backend Engineer", questions: [] }),
};

function deps(
  fetchImpl: typeof fetch,
  answers: (r: LookupResult) => Record<string, unknown> = () => ({
    status: "ok",
  }),
) {
  const submitted: LookupResult[] = [];
  return {
    submitted,
    deps: {
      fetch: fetchImpl,
      pause: async () => {},
      submit: async (r: LookupResult) => {
        submitted.push(r);
        return answers(r) as { status: string };
      },
    },
  };
}

const pending = (
  task: PendingLookup["task"],
  employer = "Acme Inc.",
): PendingLookup => ({
  jobId: "j1",
  employer,
  title: "Senior Backend Engineer",
  task,
});

describe("slugGuesses", () => {
  it("strips company suffixes and tries joined, hyphenated and first-word forms", () => {
    expect(slugGuesses("Platform Science Inc.")).toEqual([
      "platformscience",
      "platform-science",
      "platform",
    ]);
    expect(slugGuesses("Acme")).toEqual(["acme"]);
  });
});

describe("runTask", () => {
  it("find-board: guesses the board from the name, sends titles, then descriptions when asked", async () => {
    const web = fakeWeb(board);
    const { deps: d, submitted } = deps(web.fetchImpl, (r) =>
      r.type === "board" && !r.details
        ? { status: "need-details", postingIds: ["11"] }
        : {
            status: "matched",
            postingUrl: "https://job-boards.greenhouse.io/acme/jobs/11",
          },
    );
    const outcome = await runTask(
      d,
      pending({ type: "find-board", employer: "Acme Inc." }),
    );
    expect(outcome).toBe(
      "greenhouse board acme: matched https://job-boards.greenhouse.io/acme/jobs/11",
    );
    expect(submitted[0]).toMatchObject({
      type: "board",
      ats: "greenhouse",
      token: "acme",
      method: "name-slug",
      jobs: [
        { id: "11", title: "Senior Backend Engineer", location: "Bengaluru" },
        { id: "12" },
      ],
    });
    expect(submitted[1]).toMatchObject({
      details: { "11": expect.stringContaining("Build APIs") },
    });
  });

  it("find-board: falls back to the company's domain and its careers page", async () => {
    const web = fakeWeb({
      "https://autocomplete.clearbit.com/v1/companies/suggest?query=Zeta%20Systems":
        () => json([{ domain: "zeta.io" }]),
      "https://zeta.io/": () =>
        new Response(
          '<script src="https://boards.greenhouse.io/embed/job_board/js?for=zetaio"></script>',
        ),
      [`${API}/zetaio`]: () => json({ name: "Zeta" }),
      [`${API}/zetaio/jobs`]: () => json({ jobs: [] }),
    });
    const { deps: d, submitted } = deps(web.fetchImpl, () => ({
      status: "none",
    }));
    await runTask(
      d,
      pending({ type: "find-board", employer: "Zeta Systems" }, "Zeta Systems"),
    );
    expect(submitted[0]).toMatchObject({
      token: "zetaio",
      method: expect.stringMatching(/^domain:/),
    });
  });

  it("find-board: reports 'no board' when nothing is found", async () => {
    const { deps: d, submitted } = deps(fakeWeb({}).fetchImpl);
    expect(
      await runTask(
        d,
        pending({ type: "find-board", employer: "Nobody" }, "Nobody"),
      ),
    ).toBe("no board on a supported system");
    expect(submitted).toEqual([
      expect.objectContaining({ type: "board", token: null }),
    ]);
  });

  describe("Ashby", () => {
    const ASHBY = "https://api.ashbyhq.com/posting-api/job-board";
    const GRAPHQL =
      "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting";
    const POSTING = "c7d59014-b918-4c15-ae33-79f5c9f2cf9f";
    const ashbyBoard = {
      [`${ASHBY}/elevenlabs`]: () =>
        json({
          jobs: [
            {
              id: POSTING,
              title: "Full-Stack Engineer (Backend Leaning)",
              location: "United Kingdom",
              jobUrl: `https://jobs.ashbyhq.com/elevenlabs/${POSTING}`,
              isListed: true,
              descriptionPlain: "Build voice AI products.",
            },
            { id: "x", title: "Unlisted", isListed: false },
          ],
        }),
    };

    it("finds the board when Greenhouse has none, and answers detail requests from the listing", async () => {
      const web = fakeWeb(ashbyBoard);
      const { deps: d, submitted } = deps(web.fetchImpl, (r) =>
        r.type === "board" && !r.details
          ? { status: "need-details", postingIds: [POSTING] }
          : { status: "matched" },
      );
      const outcome = await runTask(
        d,
        pending({ type: "find-board", employer: "ElevenLabs" }, "ElevenLabs"),
      );
      expect(outcome).toBe("ashby board elevenlabs: matched");
      expect(submitted[0]).toMatchObject({
        ats: "ashby",
        token: "elevenlabs",
        jobs: [{ id: POSTING, title: "Full-Stack Engineer (Backend Leaning)" }],
      });
      expect(submitted[1]).toMatchObject({
        details: { [POSTING]: "Build voice AI products." },
      });
      // Descriptions came with the listing: no request per posting.
      expect(web.calls.filter((c) => c.includes(POSTING))).toEqual([]);
    });

    it("verifies a posting against the listing", async () => {
      const { deps: d, submitted } = deps(fakeWeb(ashbyBoard).fetchImpl);
      await runTask(
        d,
        pending({
          type: "verify-job",
          ats: "ashby",
          token: "elevenlabs",
          postingId: POSTING,
          region: "us",
        }),
      );
      await runTask(
        d,
        pending({
          type: "verify-job",
          ats: "ashby",
          token: "elevenlabs",
          postingId: "gone",
          region: "us",
        }),
      );
      expect(submitted).toEqual([
        expect.objectContaining({
          ats: "ashby",
          live: true,
          url: `https://jobs.ashbyhq.com/elevenlabs/${POSTING}`,
        }),
        expect.objectContaining({ ats: "ashby", live: false }),
      ]);
    });

    it("fetches the form with Ashby's read-only form query", async () => {
      const bodies: unknown[] = [];
      const form = {
        jobPosting: { id: POSTING, applicationForm: { sections: [] } },
      };
      const fetchImpl = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = String(input);
        if (url === GRAPHQL) {
          bodies.push(JSON.parse(String(init?.body)));
          return json({ data: form });
        }
        return new Response("", { status: 404 });
      }) as typeof fetch;
      const { deps: d, submitted } = deps(fetchImpl, () => ({
        status: "planned",
      }));
      expect(
        await runTask(
          d,
          pending({
            type: "fetch-schema",
            ats: "ashby",
            token: "elevenlabs",
            postingId: POSTING,
          }),
        ),
      ).toBe("form fetched, plan built");
      expect(bodies[0]).toMatchObject({
        operationName: "ApiJobPosting",
        variables: {
          organizationHostedJobsPageName: "elevenlabs",
          jobPostingId: POSTING,
        },
      });
      expect(submitted[0]).toMatchObject({
        type: "schema",
        ats: "ashby",
        payload: form,
      });
    });
  });

  it("verify-job: live posting, and a closed one", async () => {
    const live = deps(fakeWeb(board).fetchImpl);
    await runTask(
      live.deps,
      pending({
        type: "verify-job",
        ats: "greenhouse",
        token: "acme",
        postingId: "11",
        region: "us",
      }),
    );
    expect(live.submitted[0]).toMatchObject({
      type: "job",
      live: true,
      url: "https://job-boards.greenhouse.io/acme/jobs/11",
    });
    const closed = deps(fakeWeb({}).fetchImpl);
    await runTask(
      closed.deps,
      pending({
        type: "verify-job",
        ats: "greenhouse",
        token: "acme",
        postingId: "99",
        region: "us",
      }),
    );
    expect(closed.submitted[0]).toMatchObject({ type: "job", live: false });
  });

  it("follow-short-link: follows grnh.se to the posting", async () => {
    const web = fakeWeb(board, {
      "https://grnh.se/abc": "https://job-boards.greenhouse.io/acme/jobs/11",
    });
    const { deps: d, submitted } = deps(web.fetchImpl);
    await runTask(
      d,
      pending({ type: "follow-short-link", url: "https://grnh.se/abc" }),
    );
    expect(submitted[0]).toMatchObject({
      type: "job",
      token: "acme",
      postingId: "11",
      live: true,
    });
  });

  it("resolve-embedded: finds the board behind a company careers page", async () => {
    const web = fakeWeb({
      ...board,
      "https://acme.com/careers?gh_jid=11": () =>
        new Response(
          '<div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>',
        ),
    });
    const { deps: d, submitted } = deps(web.fetchImpl);
    await runTask(
      d,
      pending({
        type: "resolve-embedded",
        postingId: "11",
        pageUrl: "https://acme.com/careers?gh_jid=11",
      }),
    );
    expect(submitted[0]).toMatchObject({
      type: "job",
      token: "acme",
      postingId: "11",
    });
  });

  it("fetch-schema: sends the form, or reports the posting closed", async () => {
    const ok = deps(fakeWeb(board).fetchImpl, () => ({ status: "planned" }));
    expect(
      await runTask(
        ok.deps,
        pending({
          type: "fetch-schema",
          ats: "greenhouse",
          token: "acme",
          postingId: "11",
        }),
      ),
    ).toBe("form fetched, plan built");
    expect(ok.submitted[0]).toMatchObject({
      type: "schema",
      payload: { id: 11 },
    });
    const gone = deps(fakeWeb({}).fetchImpl, () => ({ status: "closed" }));
    await runTask(
      gone.deps,
      pending({
        type: "fetch-schema",
        ats: "greenhouse",
        token: "acme",
        postingId: "99",
      }),
    );
    expect(gone.submitted[0]).toMatchObject({ type: "job", live: false });
  });
});

describe("runLookups", () => {
  const server = (rounds: PendingLookup[][]) => {
    let call = 0;
    const posted: LookupResult[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/lookups/pending"))
        return json({ ok: true, data: rounds[call++] ?? [] });
      if (url.endsWith("/lookups/results")) {
        posted.push(JSON.parse(String(init?.body)));
        return json({ ok: true, data: { status: "none" } });
      }
      return json(
        { ok: false, error: { code: "NOT_FOUND", message: "nope" } },
        404,
      );
    }) as typeof fetch;
    return {
      client: new ApplyClient("https://apply.test", "tok", fetchImpl),
      posted,
    };
  };

  it("runs rounds until nothing is pending and remembers failures for a day", async () => {
    const { client } = server([
      [pending({ type: "follow-short-link", url: "https://grnh.se/broken" })],
      [pending({ type: "follow-short-link", url: "https://grnh.se/broken" })],
    ]);
    const failures = new Map<string, number>();
    const summary = await runLookups({
      client,
      fetch: fakeWeb({}).fetchImpl,
      pause: async () => {},
      now: () => new Date("2026-10-20T10:00:00Z"),
      recentFailures: failures,
    });
    expect(summary.lines).toHaveLength(1);
    expect(summary.lines[0]?.outcome).toMatch(/doesn't lead|unreachable/);
    expect(failures.has("j1:follow-short-link")).toBe(true);
  });

  it("skips recently failed tasks on the next run", async () => {
    const { client } = server([
      [pending({ type: "follow-short-link", url: "https://grnh.se/broken" })],
    ]);
    const summary = await runLookups({
      client,
      fetch: fakeWeb({}).fetchImpl,
      pause: async () => {},
      now: () => new Date("2026-10-20T10:00:00Z"),
      recentFailures: new Map([
        ["j1:follow-short-link", Date.parse("2026-10-20T09:00:00Z")],
      ]),
    });
    expect(summary).toMatchObject({ lines: [], skipped: 1 });
  });

  it("reports a server problem instead of throwing", async () => {
    const client = new ApplyClient("https://apply.test", "bad", (async () =>
      json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in" } },
        401,
      )) as typeof fetch);
    const summary = await runLookups({
      client,
      fetch: fakeWeb({}).fetchImpl,
      pause: async () => {},
      now: () => new Date(),
      recentFailures: new Map(),
    });
    expect(summary.error).toBe("Sign in");
  });
});
