// Runs INSIDE the job-ops container (read-only). Prints Greenhouse-linked jobs + your profile as JSON.
// Optional stdin: {"Employer Name": "greenhouse-slug"} map from the resolver; pass {} if you have none.
const Database = require("/app/orchestrator/node_modules/better-sqlite3");
const fs = require("node:fs");
const db = new Database("/app/data/jobs.db", {
  readonly: true,
  fileMustExist: true,
});
const slugs = JSON.parse(fs.readFileSync(0, "utf8"));
const jobs = db
  .prepare(
    "select id, title, employer, status, suitability_score sc, pdf_path, coalesce(nullif(application_link,''), nullif(job_url_direct,''), job_url) u from jobs where status <> 'expired'",
  )
  .all()
  .filter((j) => /greenhouse\.io|grnh\.se/.test(j.u || "") || slugs[j.employer])
  .map((j) => ({
    ...j,
    ghSlug: slugs[j.employer] || null,
    pdfExists: j.pdf_path
      ? fs.existsSync(
          j.pdf_path.startsWith("/") ? j.pdf_path : `/app/data/${j.pdf_path}`,
        )
      : false,
  }));
const r = db
  .prepare(
    "select resume_json from design_resume_documents order by updated_at desc limit 1",
  )
  .get();
const resume = r
  ? typeof r.resume_json === "string"
    ? JSON.parse(r.resume_json)
    : r.resume_json
  : null;
const b = resume?.basics || {};
const profile = {
  name: b.name,
  email: b.email,
  phone: b.phone,
  location: b.location,
  headline: b.headline,
  url: b.url,
  profiles:
    resume?.sections?.profiles?.items?.map((p) => ({
      network: p.network,
      url: p.website?.url || p.url,
    })) || [],
  education: (resume?.sections?.education?.items || [])
    .filter((i) => !i.hidden)
    .map((i) => ({
      school: i.school,
      degree: i.degree,
      area: i.area,
      grade: i.grade,
      period: i.period,
    })),
  experience: (resume?.sections?.experience?.items || [])
    .filter((i) => !i.hidden)
    .map((i) => ({
      company: i.company,
      position: i.position,
      location: i.location,
      period: i.period,
    })),
};
console.log(JSON.stringify({ jobs, profile }));
