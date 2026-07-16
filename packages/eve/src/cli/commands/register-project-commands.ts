import { InvalidArgumentError, type Command } from "#compiled/commander/index.js";

interface ProjectCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

/** Registers project-level commands without eagerly loading their flows. */
export function registerProjectCommands(input: {
  program: Command;
  logger: ProjectCommandLogger;
  appRoot: string;
}): void {
  const logs = input.program
    .command("logs")
    .description("Tail a local eve dev invocation log.")
    .argument("[log-id]", "Local log ID (defaults to mru)")
    .option("-n, --lines <count>", "Number of existing lines to print", parseLogLineCount, 10)
    .option("--no-follow", "Print existing lines and exit")
    .action(async (logId: string | undefined, options: { follow: boolean; lines: number }) => {
      const { runLogsTailCommand } = await import("./logs.js");
      await runLogsTailCommand(
        {
          log: (message) => input.logger.log(message),
          write: (text) => {
            process.stdout.write(text);
          },
        },
        input.appRoot,
        logId,
        options,
      );
    });

  logs
    .command("ls")
    .description("List local eve dev invocation logs.")
    .action(async () => {
      const { runLogsListCommand } = await import("./logs.js");
      await runLogsListCommand(input.logger, input.appRoot);
    });

  input.program
    .command("link")
    .description("Link this directory to a Vercel project and pull AI Gateway credentials.")
    .action(async () => {
      const { runLinkCommand } = await import("./link.js");
      await runLinkCommand(input.logger, input.appRoot);
    });

  input.program
    .command("deploy")
    .description("Deploy the agent to Vercel production (links first if needed).")
    .action(async () => {
      const { runDeployCommand } = await import("./deploy.js");
      await runDeployCommand(input.logger, input.appRoot);
    });
}

function parseLogLineCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`Expected a positive integer, received "${value}".`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new InvalidArgumentError(`Expected a positive integer, received "${value}".`);
  }
  return count;
}
