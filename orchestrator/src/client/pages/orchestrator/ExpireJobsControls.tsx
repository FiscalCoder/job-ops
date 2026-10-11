import { expireJobs } from "@client/api/job-liveness";
import type { JobListItem } from "@shared/types.js";
import { Clock } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/client/lib/error-toast";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

const EXPIRABLE_STATUSES: ReadonlySet<JobListItem["status"]> = new Set([
  "discovered",
  "ready",
]);

export function canExpire(jobs: Pick<JobListItem, "status">[]): boolean {
  return (
    jobs.length > 0 && jobs.every((job) => EXPIRABLE_STATUSES.has(job.status))
  );
}

function plural(count: number): string {
  return count === 1 ? "job" : "jobs";
}

/**
 * Expire the given jobs and report the outcome. Returns the ids that could
 * not be expired so the caller can keep them selected.
 */
async function expireAndReport(jobIds: string[]): Promise<Set<string>> {
  const result = await expireJobs(jobIds);
  if (result.failed === 0) {
    toast.success(
      `${result.succeeded} ${plural(result.succeeded)} marked expired`,
    );
  } else {
    toast.error(`${result.succeeded} marked expired, ${result.failed} failed.`);
  }
  return new Set(
    result.results.filter((entry) => !entry.ok).map((entry) => entry.jobId),
  );
}

interface ExpireSelectedButtonProps {
  selectedJobs: JobListItem[];
  disabled?: boolean;
  /** Called after the request with the ids that failed to expire. */
  onExpired: (failedJobIds: Set<string>) => Promise<void> | void;
}

/** Bulk action: expire every selected job. */
export const ExpireSelectedButton: React.FC<ExpireSelectedButtonProps> = ({
  selectedJobs,
  disabled = false,
  onExpired,
}) => {
  const [isExpiring, setIsExpiring] = useState(false);

  const handleClick = useCallback(async () => {
    setIsExpiring(true);
    try {
      const failedJobIds = await expireAndReport(
        selectedJobs.map((job) => job.id),
      );
      await onExpired(failedJobIds);
    } catch (error) {
      showErrorToast(error, "Failed to mark jobs expired");
    } finally {
      setIsExpiring(false);
    }
  }, [onExpired, selectedJobs]);

  if (!canExpire(selectedJobs)) return null;

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="w-full sm:w-auto"
      disabled={disabled || isExpiring}
      onClick={() => void handleClick()}
    >
      {isExpiring ? "Expiring..." : "Expire selected"}
    </Button>
  );
};

interface MarkExpiredMenuItemProps {
  jobId: string;
  onExpired: () => Promise<void> | void;
}

/** Single-job action for the job detail menu. */
export const MarkExpiredMenuItem: React.FC<MarkExpiredMenuItemProps> = ({
  jobId,
  onExpired,
}) => {
  const handleSelect = useCallback(async () => {
    try {
      const failedJobIds = await expireAndReport([jobId]);
      if (failedJobIds.size === 0) await onExpired();
    } catch (error) {
      showErrorToast(error, "Failed to mark job expired");
    }
  }, [jobId, onExpired]);

  return (
    <DropdownMenuItem onSelect={() => void handleSelect()}>
      <Clock className="mr-2 h-4 w-4" />
      Mark expired
    </DropdownMenuItem>
  );
};
