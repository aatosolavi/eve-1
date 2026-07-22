import type { Command } from "#compiled/commander/index.js";

interface TraceCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

/** Registers the `eve trace` command group without eagerly loading its flows. */
export function registerTraceCommands(input: {
  program: Command;
  logger: TraceCommandLogger;
  appRoot: string;
}): void {
  const trace = input.program
    .command("trace")
    .description("Inspect local eve dev traces (.eve/traces).");

  trace
    .command("show [traceId]", { isDefault: true })
    .description("Render a trace's waterfall (the most recent when traceId is omitted).")
    .option("--json", "Output the raw OTLP/JSON payload")
    .action(async (traceId: string | undefined, options: { json?: boolean }) => {
      const { runTraceShowCommand } = await import("./trace.js");
      await runTraceShowCommand(input.logger, input.appRoot, traceId, options);
    });

  trace
    .command("ls")
    .description("List captured traces, most recent first.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { runTraceListCommand } = await import("./trace.js");
      await runTraceListCommand(input.logger, input.appRoot, options);
    });

  trace
    .command("export <traceId>")
    .description("Emit a trace's OTLP/JSON, or POST it to an OTLP/HTTP endpoint.")
    .option("--otlp <url>", "POST the trace to this OTLP/HTTP endpoint")
    .action(async (traceId: string, options: { otlp?: string }) => {
      const { runTraceExportCommand } = await import("./trace.js");
      await runTraceExportCommand(input.logger, input.appRoot, traceId, options);
    });
}
