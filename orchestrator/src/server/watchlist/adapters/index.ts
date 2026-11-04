import type { WatchedSourceType } from "@shared/types";
import { ashbyWatchlistAdapter } from "./ashby";
import { bamboohrWatchlistAdapter } from "./bamboohr";
import { greenhouseWatchlistAdapter } from "./greenhouse";
import type { WatchlistCatalogSourceAdapter } from "./types";
import { workdayWatchlistAdapter } from "./workday";
import { boardAdapter } from "../board-adapter";
import { leverBoard, smartRecruitersBoard } from "../boards/global";
import { darwinboxBoard, kekaBoard, zohoRecruitBoard } from "../boards/india";

const adapters = [
  workdayWatchlistAdapter,
  bamboohrWatchlistAdapter,
  greenhouseWatchlistAdapter,
  ashbyWatchlistAdapter,
  // Fork: company boards on Lever, SmartRecruiters and the ATSes Indian companies use.
  boardAdapter(leverBoard),
  boardAdapter(smartRecruitersBoard),
  boardAdapter(kekaBoard),
  boardAdapter(darwinboxBoard),
  boardAdapter(zohoRecruitBoard),
] as const;

const adaptersByType = new Map<
  WatchedSourceType,
  WatchlistCatalogSourceAdapter
>(adapters.map((adapter) => [adapter.sourceType, adapter]));

export function listWatchlistSourceAdapters(): WatchlistCatalogSourceAdapter[] {
  return [...adapters];
}

export function getWatchlistSourceAdapter(
  sourceType: WatchedSourceType,
): WatchlistCatalogSourceAdapter | null {
  return adaptersByType.get(sourceType) ?? null;
}

export function requireWatchlistSourceAdapter(
  sourceType: WatchedSourceType,
): WatchlistCatalogSourceAdapter {
  const adapter = getWatchlistSourceAdapter(sourceType);
  if (!adapter) {
    throw new Error(`Unsupported watchlist source type: ${sourceType}`);
  }
  return adapter;
}
