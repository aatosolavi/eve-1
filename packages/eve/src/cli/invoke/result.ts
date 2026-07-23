import { z } from "#compiled/zod/index.js";
import { inputRequestSchema } from "#client/index.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";

const sessionCursorSchema = z
  .object({
    continuationToken: z.string().optional(),
    sessionId: z.string().min(1),
    streamIndex: z.number().int().nonnegative(),
  })
  .strict();
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z.object({ kind: z.literal("remote"), serverUrl: z.url() }).strict(),
]);
const authorizationChallengeSchema: z.ZodType<ConnectionAuthorizationChallenge> = z
  .object({
    displayName: z.string().optional(),
    expiresAt: z.string().optional(),
    instructions: z.string().optional(),
    url: z.string().optional(),
    userCode: z.string().optional(),
  })
  .strict();
const authorizationInterruptSchema = z
  .object({
    authorization: authorizationChallengeSchema.optional(),
    description: z.string(),
    name: z.string(),
    webhookUrl: z.string().optional(),
  })
  .strict();
const invokeResumeSchema = z
  .object({
    session: sessionCursorSchema,
    target: targetSchema,
  })
  .strict();

const invokeResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      resume: invokeResumeSchema,
      status: z.literal("running"),
    })
    .strict(),
  z
    .object({
      requests: z.array(inputRequestSchema).readonly(),
      resume: invokeResumeSchema,
      status: z.literal("input-required"),
    })
    .strict(),
  z
    .object({
      authorizations: z.array(authorizationInterruptSchema).min(1).readonly(),
      resume: invokeResumeSchema,
      status: z.literal("authorization-required"),
    })
    .strict(),
  z
    .object({
      message: z.string().optional(),
      resume: invokeResumeSchema.optional(),
      status: z.literal("completed"),
    })
    .strict(),
  z
    .object({
      message: z.string(),
      resume: invokeResumeSchema.optional(),
      status: z.literal("failed"),
    })
    .strict(),
  z
    .object({
      code: z.string().optional(),
      message: z.string(),
      resume: invokeResumeSchema.optional(),
      status: z.literal("authentication-required"),
    })
    .strict(),
]);

export type InvokeSessionCursor = z.infer<typeof sessionCursorSchema>;
export type AuthorizationInterrupt = z.infer<typeof authorizationInterruptSchema>;

/** Durable session coordinates emitted by `eve invoke`. Credentials are deliberately excluded. */
export type InvokeResume = z.infer<typeof invokeResumeSchema>;
export type InvokeResult = z.infer<typeof invokeResultSchema>;

/** Parses a complete, resumable result from a previous `eve invoke` command. */
export function parseInvokeResumeInput(value: unknown): InvokeResult & { resume: InvokeResume } {
  const result = invokeResultSchema.safeParse(value);
  if (result.success && result.data.resume !== undefined) {
    return result.data as InvokeResult & { resume: InvokeResume };
  }
  throw new Error("Resume JSON is not a valid resumable eve invoke result.");
}

/** JSON Schema generated from the canonical invoke result runtime schema. */
export const invokeResultJsonSchema = {
  ...z.toJSONSchema(invokeResultSchema, {
    io: "input",
    target: "draft-2020-12",
    unrepresentable: "any",
  }),
  $id: "https://eve.dev/schemas/invoke-result.json",
  title: "eve invoke result",
};
