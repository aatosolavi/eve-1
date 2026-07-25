import {
  continueCodeModeInterrupt,
  createCodeModeTool,
  getCodeModeInterrupt,
  requestCodeModeInterrupt,
  unwrapCodeModeResult,
} from "#compiled/experimental-ai-sdk-code-mode/index.js";
import { installWorkflowSandboxModule } from "#core/workflow-sandbox-module.js";

installWorkflowSandboxModule({
  continueCodeModeInterrupt,
  createCodeModeTool,
  getCodeModeInterrupt,
  requestCodeModeInterrupt,
  unwrapCodeModeResult,
});

export default function installWorkflowSandboxRuntimePlugin(): void {}
