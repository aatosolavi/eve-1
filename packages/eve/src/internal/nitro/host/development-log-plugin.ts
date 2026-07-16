import { ensureWorkerDevelopmentLogOutputCapture } from "#internal/dev-logs/output-capture.js";

export default function installDevelopmentLogCapture(): void {
  ensureWorkerDevelopmentLogOutputCapture();
}
