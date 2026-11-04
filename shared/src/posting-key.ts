/**
 * Which posting a job link points to, whatever the spelling: one posting reaches us under
 * many links (Greenhouse's boards.greenhouse.io/<co>/jobs/<id>, job-boards.greenhouse.io/…,
 * a company page with ?gh_jid=<id>; Workday lists one requisition under a URL per location).
 * `postingKey()` reads the posting's identity out of a link ("greenhouse:8686811002"); two
 * jobs with one key are one posting. A link naming no known system gives null: guessing an
 * identity from an unknown path would merge different jobs.
 *
 * Readers follow JobNavigator's backend/scraper/_shared/postings.py (MIT,
 * github.com/vesaias/JobNavigator).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKDAY_REQ = /_([A-Za-z0-9][A-Za-z0-9-]*\d[A-Za-z0-9-]*)$/;

const is = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

type Reader = (
  url: URL,
  host: string,
  segments: string[],
  query: URLSearchParams,
) => string | null;

const greenhouse: Reader = (_url, host, seg, query) => {
  // A Greenhouse job id is global: the board's name isn't part of the key.
  const gh = query.get("gh_jid");
  if (gh && /^\d+$/.test(gh)) return `greenhouse:${gh}`;
  if (!is(host, "greenhouse.io")) return null;
  const token = query.get("token");
  if (seg.includes("job_app") && token && /^\d+$/.test(token))
    return `greenhouse:${token}`;
  const at = seg.indexOf("jobs");
  const id = at >= 0 ? seg[at + 1] : undefined;
  return id && /^\d+$/.test(id) ? `greenhouse:${id}` : null;
};

const lever: Reader = (_url, host, seg) =>
  is(host, "lever.co") && seg[1] && UUID.test(seg[1])
    ? `lever:${seg[1].toLowerCase()}`
    : null;

const ashby: Reader = (_url, host, seg, query) => {
  if (is(host, "ashbyhq.com")) {
    const id = seg.slice(1).find((s) => UUID.test(s));
    if (id) return `ashby:${id.toLowerCase()}`;
  }
  const jid = query.get("ashby_jid");
  return jid && UUID.test(jid) ? `ashby:${jid.toLowerCase()}` : null;
};

const workday: Reader = (_url, host, seg) => {
  // …/<site>/job/<location>/<Title>_<REQ>: one requisition per location path, so the key is
  // tenant + requisition.
  if (!seg.includes("job")) return null;
  let tenant: string | undefined;
  if (is(host, "myworkdayjobs.com")) tenant = host.split(".")[0];
  else if (is(host, "myworkdaysite.com")) {
    const at = seg.indexOf("recruiting");
    tenant = at >= 0 ? seg[at + 1]?.toLowerCase() : undefined;
  }
  const req = tenant ? seg.at(-1)?.match(WORKDAY_REQ)?.[1] : undefined;
  return tenant && req ? `workday:${tenant}:${req.toUpperCase()}` : null;
};

const smartRecruiters: Reader = (_url, host, seg) => {
  if (!is(host, "smartrecruiters.com")) return null;
  // jobs.smartrecruiters.com/<Company>/<id>-<title-slug>
  const id = seg[1]?.match(/^(\d{6,})/)?.[1];
  return id ? `smartrecruiters:${id}` : null;
};

const keka: Reader = (_url, host, seg) => {
  if (!is(host, "keka.com")) return null;
  const at = seg.indexOf("jobdetails");
  const id = at >= 0 ? seg[at + 1] : undefined;
  return id ? `keka:${host.split(".")[0]}:${id}` : null;
};

const darwinbox: Reader = (_url, host, seg) => {
  if (!is(host, "darwinbox.in")) return null;
  const at = seg.findIndex((s) => s.toLowerCase() === "jobdetails");
  const id = at >= 0 ? seg[at + 1] : undefined;
  return id ? `darwinbox:${host.split(".")[0]}:${id}` : null;
};

const zohoRecruit: Reader = (_url, host, seg) => {
  if (!/\.zohorecruit\./.test(host)) return null;
  const at = seg.indexOf("Careers");
  const id = at >= 0 ? seg[at + 1]?.match(/^(\d+)/)?.[1] : undefined;
  return id ? `zoho:${host.split(".")[0]}:${id}` : null;
};

const linkedin: Reader = (_url, host, seg, query) => {
  if (!is(host, "linkedin.com")) return null;
  const current = query.get("currentJobId");
  if (current && /^\d+$/.test(current)) return `linkedin:${current}`;
  const at = seg.indexOf("view");
  const id = at >= 0 ? seg[at + 1]?.match(/(\d{6,})\/?$/)?.[1] : undefined;
  return seg.includes("jobs") && id ? `linkedin:${id}` : null;
};

const READERS: readonly Reader[] = [
  greenhouse,
  lever,
  ashby,
  workday,
  smartRecruiters,
  keka,
  darwinbox,
  zohoRecruit,
  linkedin,
];

export function postingKey(link: string | null | undefined): string | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  for (const read of READERS) {
    const key = read(url, host, segments, url.searchParams);
    if (key) return key;
  }
  return null;
}

/** Every posting key a job's links name (its page and where you apply). */
export function postingKeysOf(job: {
  readonly jobUrl: string;
  readonly applicationLink?: string | null;
}): string[] {
  return [
    ...new Set(
      [postingKey(job.jobUrl), postingKey(job.applicationLink)].filter(
        (key): key is string => key !== null,
      ),
    ),
  ];
}
