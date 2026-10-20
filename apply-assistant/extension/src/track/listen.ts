import { forgetTab, noteAddress, noteOpener } from "./tabs";

/**
 * Background wiring for tracked application tabs: tab addresses (from navigation events,
 * never page content), which tab opened which, and closed tabs.
 */
export function listenForApplicationTabs(): void {
  const onPage = (details: { tabId: number; frameId: number; url: string }) => {
    if (details.frameId === 0 && details.tabId >= 0)
      void noteAddress(details.tabId, details.url);
  };
  chrome.webNavigation.onCommitted.addListener(onPage);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onPage);
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void noteOpener(details.tabId, details.sourceTabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));
}
