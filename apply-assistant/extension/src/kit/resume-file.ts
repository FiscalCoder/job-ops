/**
 * Saves the job's tailored resume to Downloads/JobOps/<Employer> - <Title>/<name>.pdf, so an
 * upload dialog takes its full path (paste, Enter) instead of a hunt through Downloads.
 */

const DOWNLOAD_TIMEOUT_MS = 30_000;

/** A file or folder name Windows, macOS and Linux all accept. */
export function safeName(text: string, max = 80): string {
  const cleaned = text
    .replace(/[<>:"/\\|?*]+/g, " ")
    .split("")
    .filter((c) => c.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, max)
    .trim();
  return cleaned || "Job";
}

/** The download path, relative to the Downloads folder. */
export function resumePath(
  job: { employer: string; title: string },
  fileName: string,
): string {
  return `JobOps/${safeName(`${job.employer} - ${job.title}`)}/${safeName(fileName, 120)}`;
}

function waitForDownload(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error("The download took too long"));
    }, DOWNLOAD_TIMEOUT_MS);
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === "interrupted") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        reject(
          new Error(
            `The download failed (${delta.error?.current ?? "interrupted"})`,
          ),
        );
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

/** Saves the PDF (replacing an older copy) and returns its full path on disk. */
export async function saveResume(
  job: { employer: string; title: string },
  resume: { base64: string; name: string },
): Promise<string> {
  const bytes = Uint8Array.from(atob(resume.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/pdf" }),
  );
  try {
    const id = await chrome.downloads.download({
      url,
      filename: resumePath(job, resume.name),
      conflictAction: "overwrite",
      saveAs: false,
    });
    await waitForDownload(id);
    const [item] = await chrome.downloads.search({ id });
    if (!item?.filename)
      throw new Error("Chrome didn't say where it saved the file");
    return item.filename;
  } finally {
    URL.revokeObjectURL(url);
  }
}
