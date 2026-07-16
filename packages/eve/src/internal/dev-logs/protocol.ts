import { z } from "#compiled/zod/index.js";

export const EVE_DEV_LOGS_ENV = "EVE_DEV_LOGS";
export const DEVELOPMENT_LOG_ROUTE = "/eve/v1/dev/internal/log";
export const DEVELOPMENT_LOG_FLUSH_ROUTE = "/eve/v1/dev/internal/log/flush";

export const developmentLogIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

const correlationFields = {
  sessionId: z.string().min(1).optional(),
};

export const developmentLogEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...correlationFields,
      at: z.iso.datetime(),
      sandboxId: z.string().min(1),
      stream: z.enum(["stderr", "stdout"]),
      text: z.string(),
      type: z.literal("sandbox.output"),
    })
    .strict(),
  z
    .object({
      ...correlationFields,
      at: z.iso.datetime(),
      process: z.enum(["parent", "worker"]),
      stream: z.enum(["stderr", "stdout"]),
      text: z.string(),
      type: z.literal("process.output"),
    })
    .strict(),
]);

export type DevelopmentLogEvent = z.infer<typeof developmentLogEventSchema>;

export const developmentLogBatchSchema = z
  .object({
    events: z.array(developmentLogEventSchema).min(1).max(256),
  })
  .strict();

export type DevelopmentLogBatch = z.infer<typeof developmentLogBatchSchema>;

/** Development logging is on by default and disabled only by `EVE_DEV_LOGS=0`. */
export function areDevelopmentLogsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[EVE_DEV_LOGS_ENV] !== "0";
}

export function isSafeDevelopmentLogId(value: string): boolean {
  return developmentLogIdSchema.safeParse(value).success;
}
