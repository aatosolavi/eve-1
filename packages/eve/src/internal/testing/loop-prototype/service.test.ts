import { describe, expect, it } from "vitest";

import {
  createExecuteToolEffect,
  createGenerateEffect,
  effectDefinitions,
  EffectProtocolError,
} from "./effect-definitions.js";
import { eventId, eventLogId, operationId, sessionId } from "./ids.js";
import {
  MemoryPrototypeService,
  type PrototypeService,
  SqlitePrototypeService,
} from "./service.js";
import { appendUser, emptyHistory } from "./transcript.js";

const serviceFactories = [
  { create: () => new MemoryPrototypeService(), name: "memory" },
  { create: () => new SqlitePrototypeService(":memory:"), name: "SQLite" },
] satisfies readonly { readonly create: () => PrototypeService; readonly name: string }[];

describe("prototype service", () => {
  for (const { create, name } of serviceFactories) {
    it(`assigns stream sequence and deduplicates event IDs in ${name}`, async () => {
      const service = create();
      const log = eventLogId("session-1:events");
      const firstOperation = operationId(sessionId("session-1"), 0, "first");
      const first = {
        id: eventId(firstOperation, 0),
        operationId: firstOperation,
        payload: { type: "first" },
      } as const;
      const secondOperation = operationId(sessionId("session-1"), 0, "second");

      try {
        expect(await service.append(log, first)).toMatchObject({ sequence: 0 });
        expect(await service.append(log, first)).toMatchObject({ sequence: 0 });
        expect(
          await service.append(log, {
            id: eventId(secondOperation, 0),
            operationId: secondOperation,
            payload: { type: "second" },
          }),
        ).toMatchObject({ sequence: 1 });
        await expect(
          service.append(log, { ...first, payload: { type: "different" } }),
        ).rejects.toThrow("different bytes");
      } finally {
        await service.close();
      }
    });

    it(`reuses a result committed before ambiguous completion in ${name}`, async () => {
      const service = create();
      const id = sessionId("session-1");
      const call = createGenerateEffect({
        generationOrdinal: 0,
        history: appendUser(emptyHistory(), "eventual"),
        scenario: { kind: "retry-once" },
        sessionId: id,
        turnOrdinal: 0,
      });

      try {
        await expect(service.effect(call)).rejects.toThrow(
          "Injected failure after the visible generation effect.",
        );
        expect(service.attemptCount(call.id)).toBe(1);
        expect(service.executionCount(call.id)).toBe(1);

        await expect(service.effect(call)).resolves.toMatchObject({
          finish: { output: "retry:eventual" },
        });
        expect(service.attemptCount(call.id)).toBe(2);
        expect(service.executionCount(call.id)).toBe(1);
        expect(service.visibleEffectCount(call.id)).toBe(1);
      } finally {
        await service.close();
      }
    });

    it(`rejects conflicting committed result bytes in ${name}`, async () => {
      const service = create();
      const call = createGenerateEffect({
        generationOrdinal: 0,
        history: appendUser(emptyHistory(), "hello"),
        scenario: { kind: "echo" },
        sessionId: sessionId("session-1"),
        turnOrdinal: 0,
      });
      const first = JSON.stringify({ assistant: {}, finish: null, requests: [] });

      try {
        expect(service.commitResult(call, first)).toBe(first);
        expect(service.commitResult(call, first)).toBe(first);
        expect(() => service.commitResult(call, JSON.stringify({ different: true }))).toThrow(
          "different bytes",
        );
      } finally {
        await service.close();
      }
    });

    it(`rejects malformed or mismatched committed results in ${name}`, async () => {
      const service = create();
      const request = {
        input: null,
        kind: "tool" as const,
        name: "echo",
        requestId: "request-1",
      };
      const call = createExecuteToolEffect(request);

      try {
        service.commitResult(
          call,
          JSON.stringify({ isError: false, requestId: "request-2", value: null }),
        );
        await expect(service.effect(call)).rejects.toThrow(EffectProtocolError);
      } finally {
        await service.close();
      }
    });
  }

  it("declares retry and idempotency once per effect", () => {
    expect(effectDefinitions).toEqual({
      "execute-tool": { retry: { idempotency: "required", maxAttempts: 2 } },
      generate: { retry: { idempotency: "required", maxAttempts: 2 } },
    });
  });

  it("does not alias semantic ID tuples containing delimiters", () => {
    const first = operationId(sessionId("s"), 0, "p:turn:1:q");
    const second = operationId(sessionId("s:turn:0:p"), 1, "q");

    expect(first).not.toBe(second);
  });
});
