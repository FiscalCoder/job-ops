import {
  INTERNSHIP_DURATION_SETTING_KEY,
  parseDurationSetting,
} from "@shared/internship-duration.js";
import { resolveSearchCities } from "@shared/search-cities.js";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
} from "@shared/types/extractors";
import { runUnstop, type UnstopProgressEvent } from "./run";

const DEFAULT_MAX_JOBS_PER_TERM = 20;

function toProgress(event: UnstopProgressEvent): ExtractorProgressEvent {
  const complete = event.type === "term_complete";
  return {
    phase: "list",
    termsProcessed: complete ? event.termIndex : event.termIndex - 1,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    jobPagesEnqueued: complete ? event.jobsFoundTerm : undefined,
    jobPagesProcessed: complete ? event.jobsFoundTerm : undefined,
    detail: complete
      ? `Unstop: completed ${event.termIndex}/${event.termTotal} (${event.searchTerm}) with ${event.jobsFoundTerm ?? 0} internships`
      : `Unstop: keyword ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
  };
}

function readPositiveInt(value: string | undefined): number | undefined {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readWorkplaceTypes(
  value: string | undefined,
): Array<"remote" | "hybrid" | "onsite"> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is "remote" | "hybrid" | "onsite" =>
            item === "remote" || item === "hybrid" || item === "onsite",
        )
      : undefined;
  } catch {
    return undefined;
  }
}

export const manifest: ExtractorManifest = {
  id: "unstop",
  displayName: "Unstop",
  providesSources: ["unstop"],
  locationCapabilities: {
    unstop: { supportedCountryKeys: ["india"] },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };

    const cities = resolveSearchCities({
      list: context.sourceLocationPlan?.requestedCities,
      single: context.settings.searchCities ?? context.settings.jobspyLocation,
    });
    const selectedOnly =
      (context.locationIntent?.geoScope ??
        context.settings.locationSearchScope) === "selected_only";
    const result = await runUnstop({
      searchTerms: context.searchTerms,
      cities,
      workplaceTypes: readWorkplaceTypes(context.settings.workplaceTypes),
      includeRemote: !(selectedOnly && cities.length > 0),
      duration: parseDurationSetting(
        context.settings[INTERNSHIP_DURATION_SETTING_KEY],
      ),
      maxJobsPerTerm:
        readPositiveInt(context.settings.jobspyResultsWanted) ??
        DEFAULT_MAX_JOBS_PER_TERM,
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (!context.shouldCancel?.()) context.onProgress?.(toProgress(event));
      },
    });

    if (!result.success) {
      return { success: false, jobs: [], error: result.error };
    }
    return result.errors
      ? { success: true, jobs: result.jobs, sourceErrors: result.errors }
      : { success: true, jobs: result.jobs };
  },
};

export default manifest;
