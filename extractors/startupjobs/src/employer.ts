/**
 * startup.jobs detail pages sometimes yield the company link's text ("View company profile")
 * instead of the company's name. The name is still in the listing's address
 * (`/<title-slug>-<company-slug>-<id>`) and in the startup.jobs company link.
 */

const LINK_LABEL = /^view company(\s+profile)?$/i;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nameFromSlug(slug: string): string | null {
  const words = slug.split("-").filter(Boolean);
  if (words.length === 0) return null;
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function lastPathSegment(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? null;
  } catch {
    return null;
  }
}

function fromCompanyLink(employerUrl: string | undefined): string | null {
  if (
    !employerUrl ||
    !/^https?:\/\/(www\.)?startup\.jobs\/company\//i.test(employerUrl)
  ) {
    return null;
  }
  const slug = lastPathSegment(employerUrl);
  return slug ? nameFromSlug(slug) : null;
}

function fromListingAddress(
  jobUrl: string,
  title: string | undefined,
): string | null {
  const segment = lastPathSegment(jobUrl);
  const titleSlug = title ? slugify(title) : "";
  if (!segment || !titleSlug) return null;
  // Strip the numeric id, then the title, then a repeat-posting counter ("-2").
  const withoutId = segment.replace(/-\d+$/, "");
  if (!withoutId.startsWith(`${titleSlug}-`)) return null;
  const companySlug = withoutId
    .slice(titleSlug.length + 1)
    .replace(/-\d+$/, "");
  return nameFromSlug(companySlug);
}

export function resolveStartupJobEmployer(row: {
  employer?: string;
  employerUrl?: string;
  jobUrl: string;
  title?: string;
}): string {
  const employer = row.employer?.trim();
  if (employer && !LINK_LABEL.test(employer)) return employer;
  return (
    fromCompanyLink(row.employerUrl) ??
    fromListingAddress(row.jobUrl, row.title) ??
    "Unknown Employer"
  );
}
