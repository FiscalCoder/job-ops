import type {
  ExtractorManifest,
  ExtractorProgressEvent,
} from "@shared/types/extractors";
import { type HackerNewsProgressEvent, runHackerNews } from "./run";

function toProgress(event: HackerNewsProgressEvent): ExtractorProgressEvent {
  const complete = event.type === "term_complete";
  return {
    phase: "list",
    termsProcessed: complete ? event.termIndex : event.termIndex - 1,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    jobPagesEnqueued: complete ? event.jobsFoundTerm : undefined,
    jobPagesProcessed: complete ? event.jobsFoundTerm : undefined,
    detail: complete
      ? `Hacker News: completed ${event.termIndex}/${event.termTotal} (${event.searchTerm}) with ${event.jobsFoundTerm ?? 0} jobs`
      : `Hacker News: term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
  };
}

export const manifest: ExtractorManifest = {
  id: "hackernews",
  displayName: "Hacker News (Who is hiring)",
  providesSources: ["hackernews"],
  locationCapabilities: {
    hackernews: { supportedCountryKeys: null },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };

    const parsedLimit = context.settings.jobspyResultsWanted
      ? Number.parseInt(context.settings.jobspyResultsWanted, 10)
      : Number.NaN;
    const result = await runHackerNews({
      searchTerms: context.searchTerms,
      selectedCountry: context.selectedCountry,
      workplaceTypes: context.settings.workplaceTypes
        ? JSON.parse(context.settings.workplaceTypes)
        : undefined,
      maxJobsPerTerm: Number.isFinite(parsedLimit) ? parsedLimit : 50,
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (!context.shouldCancel?.()) context.onProgress?.(toProgress(event));
      },
    });

    return result.success
      ? { success: true, jobs: result.jobs }
      : { success: false, jobs: [], error: result.error };
  },
};

export default manifest;
