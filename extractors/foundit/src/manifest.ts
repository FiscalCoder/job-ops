import {
  INTERNSHIP_DURATION_SETTING_KEY,
  parseDurationSetting,
} from "@shared/internship-duration.js";
import { resolveSearchCities } from "@shared/search-cities.js";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
} from "@shared/types/extractors";
import { type FounditProgressEvent, runFoundit } from "./run";

const DEFAULT_MAX_JOBS_PER_TERM = 20;

function toProgress(event: FounditProgressEvent): ExtractorProgressEvent {
  const complete = event.type === "term_complete";
  const where = event.location ? ` in ${event.location}` : "";
  return {
    phase: "list",
    termsProcessed: complete ? event.termIndex : event.termIndex - 1,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    jobPagesEnqueued: complete ? event.jobsFoundTerm : undefined,
    jobPagesProcessed: complete ? event.jobsFoundTerm : undefined,
    detail: complete
      ? `Foundit: completed ${event.termIndex}/${event.termTotal} (${event.searchTerm}${where}) with ${event.jobsFoundTerm ?? 0} internships`
      : `Foundit: search ${event.termIndex}/${event.termTotal} (${event.searchTerm}${where})`,
  };
}

function readPositiveInt(value: string | undefined): number | undefined {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export const manifest: ExtractorManifest = {
  id: "foundit",
  displayName: "Foundit (internships)",
  providesSources: ["foundit"],
  locationCapabilities: {
    foundit: { supportedCountryKeys: ["india"] },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };

    const existingJobUrls = await context.getExistingJobUrls?.();
    const result = await runFoundit({
      searchTerms: context.searchTerms,
      cities: resolveSearchCities({
        list: context.sourceLocationPlan?.requestedCities,
        single:
          context.settings.searchCities ?? context.settings.jobspyLocation,
      }),
      duration: parseDurationSetting(
        context.settings[INTERNSHIP_DURATION_SETTING_KEY],
      ),
      maxJobsPerTerm:
        readPositiveInt(context.settings.jobspyResultsWanted) ??
        DEFAULT_MAX_JOBS_PER_TERM,
      existingJobUrls,
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
