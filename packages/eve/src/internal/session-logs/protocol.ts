import { z } from "#compiled/zod/index.js";

export const EVE_SESSION_LOGS_ENV = "EVE_SESSION_LOGS";
export const DEVELOPMENT_SESSION_LOG_ROUTE = "/eve/v1/dev/internal/session-log";
export const DEVELOPMENT_SESSION_LOG_FLUSH_ROUTE = "/eve/v1/dev/internal/session-log/flush";

export const sessionLogIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

const sessionLogEventBase = {
  at: z.iso.datetime(),
  sessionId: sessionLogIdSchema,
};

export const developmentSessionLogEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...sessionLogEventBase,
      sandboxId: z.string().min(1),
      stream: z.enum(["stderr", "stdout"]),
      text: z.string(),
      type: z.literal("sandbox.output"),
    })
    .strict(),
  z
    .object({
      ...sessionLogEventBase,
      stream: z.enum(["stderr", "stdout"]),
      text: z.string(),
      type: z.literal("process.output"),
    })
    .strict(),
]);

export type DevelopmentSessionLogEvent = z.infer<typeof developmentSessionLogEventSchema>;

export const developmentSessionLogBatchSchema = z
  .object({
    events: z.array(developmentSessionLogEventSchema).min(1).max(256),
  })
  .strict();

export type DevelopmentSessionLogBatch = z.infer<typeof developmentSessionLogBatchSchema>;

/** Session recording is on by default and disabled only by `EVE_SESSION_LOGS=0`. */
export function areSessionLogsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[EVE_SESSION_LOGS_ENV] !== "0";
}

/** Keeps a session identifier inside the app-owned log directory. */
export function isSafeSessionLogId(value: string): boolean {
  return sessionLogIdSchema.safeParse(value).success;
}
