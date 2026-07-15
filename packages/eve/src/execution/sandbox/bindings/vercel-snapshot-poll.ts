import { isVercelSnapshottingError } from "#execution/sandbox/bindings/vercel-errors.js";

/*
 * How long to keep polling for a concurrent build's in-progress snapshot
 * before giving up, and how long to wait between polls. Taking a snapshot
 * is a compress-and-upload-to-S3 operation that can run for tens of
 * seconds, so we wait generously rather than fail a build over a transient
 * race that resolves on its own. We can't poll the snapshot object's
 * status directly (its id isn't published until the snapshot completes),
 * so each poll re-runs the caller's attempt.
 */
const SNAPSHOTTING_POLL_DEADLINE_MS = 120_000;
const SNAPSHOTTING_POLL_INTERVAL_MS = 5_000;

/**
 * Runs `attempt`, retrying while it fails with a `sandbox_snapshotting`
 * 422. Template keys are content-derived, so a name collision means a
 * concurrent build is producing the identical image: once its snapshot
 * finishes, the next attempt reuses it instead of rebuilding. Other errors
 * propagate at once; exceeding the deadline throws, naming the template.
 */
export async function ensureWithConcurrentSnapshotPolling<T>(input: {
  readonly templateKey: string;
  readonly attempt: () => Promise<T>;
  readonly log?: (message: string) => void;
}): Promise<T> {
  let waitedMs = 0;
  for (;;) {
    try {
      return await input.attempt();
    } catch (error) {
      if (!isVercelSnapshottingError(error)) {
        throw error;
      }
      if (waitedMs >= SNAPSHOTTING_POLL_DEADLINE_MS) {
        throw new Error(
          `Gave up after ${Math.round(SNAPSHOTTING_POLL_DEADLINE_MS / 1_000)}s waiting for an ` +
            `in-progress snapshot of sandbox template "${input.templateKey}" to complete. A ` +
            "concurrent build is snapshotting the same template and it did not finish in time; " +
            "retry the build, or rerun once the other build has completed.",
          { cause: error },
        );
      }
      input.log?.(
        `sandbox template "${input.templateKey}" is being snapshotted by a concurrent build; ` +
          `waited ${Math.round(waitedMs / 1_000)}s of ` +
          `${Math.round(SNAPSHOTTING_POLL_DEADLINE_MS / 1_000)}s, polling again`,
      );
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOTTING_POLL_INTERVAL_MS));
      waitedMs += SNAPSHOTTING_POLL_INTERVAL_MS;
    }
  }
}
