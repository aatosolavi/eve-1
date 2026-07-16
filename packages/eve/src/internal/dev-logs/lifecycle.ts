import type { DevBootProgressEvent, DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import { DevelopmentLog } from "#internal/dev-logs/development-log.js";
import { areDevelopmentLogsEnabled } from "#internal/dev-logs/protocol.js";
import { toErrorMessage } from "#shared/errors.js";

export async function openDevelopmentLog(
  appRoot: string,
  developmentRunId: string,
): Promise<DevelopmentLog | undefined> {
  if (!areDevelopmentLogsEnabled()) return undefined;
  try {
    return await DevelopmentLog.open({ appRoot, logId: developmentRunId });
  } catch (error) {
    console.warn(`[eve:dev] failed to open development log: ${toErrorMessage(error)}`);
    return undefined;
  }
}

export function createDevelopmentLogBootReporter(
  developmentLog: DevelopmentLog | undefined,
  report: DevBootProgressReporter | undefined,
): DevBootProgressReporter | undefined {
  if (developmentLog === undefined && report === undefined) return undefined;
  return (event: DevBootProgressEvent) => {
    report?.(event);
    if (event.type !== "phase-finished" || developmentLog === undefined) return;
    void developmentLog
      .appendDiagnostic({
        level: "info",
        message: `${event.phase} finished in ${String(event.elapsedMs)}ms`,
        source: "dev.boot",
      })
      .catch(() => undefined);
  };
}
