import { z } from "#compiled/zod/index.js";

import { parseJsonObject, type JsonObject } from "#shared/json.js";

/** Converts a Zod schema to an embeddable JSON Schema object. */
export function toJsonSchema(schema: z.ZodType): JsonObject {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
  return parseJsonObject(jsonSchema);
}
