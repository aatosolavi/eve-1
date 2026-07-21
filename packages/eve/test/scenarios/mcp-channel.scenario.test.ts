import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const TOKEN = "mcp-scenario-token";

const DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: { zod: "^4.3.6" },
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4-mini" });
`,
    "agent/channels/delegate.ts": `import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${TOKEN}") return null;
    return {
      attributes: {},
      authenticator: "scenario-bearer",
      principalId: request.headers.get("x-principal") ?? "alice",
      principalType: "user",
    };
  },
  description: "Runs deterministic scenario tasks.",
  route: "/delegate/mcp",
});
`,
    "agent/instructions.md": "Follow explicit tool and exact-reply requests.\n",
  },
  installDependencies: true,
  name: "mcp-channel",
};

describe("mcpChannel over a real Nitro server", () => {
  it("keeps invocations durable across stateless requests, principals, and input", async () => {
    const app = await scenarioApp(DESCRIPTOR);
    const server = await startEveDev(app.appRoot);

    try {
      const unauthorized = await fetch(new URL("/delegate/mcp", server.url), {
        method: "POST",
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

      const started = await callTool(server.url, "agent_start", {
        message: "Reply with the exact string `mcp-durable` and nothing else.",
      });
      expect(started.status).toBe("working");

      // Every call creates a fresh MCP transport. A different authorized principal can
      // resume because the durable invocation id is the capability handle.
      const completed = await readUntilTerminal(server.url, started.invocationId, "bob");
      expect(completed).toMatchObject({ result: "mcp-durable", status: "completed" });

      const question = await callTool(server.url, "agent_start", {
        message: "Call ask_question to ask whether to proceed.",
      });
      const inputRequired = await readUntilStatus(
        server.url,
        question.invocationId,
        "input_required",
      );
      const request = inputRequired.inputRequests?.[0];
      expect(request?.requestId).toBeTypeOf("string");
      await callTool(server.url, "agent_respond", {
        invocationId: question.invocationId,
        responses: [{ optionId: request?.options?.[0]?.id, requestId: request?.requestId }],
      });
      await expect(readUntilTerminal(server.url, question.invocationId)).resolves.toMatchObject({
        status: "completed",
      });
    } catch (error) {
      throw new Error(
        `MCP scenario failed.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        { cause: error },
      );
    } finally {
      await server.stop();
    }
  }, 360_000);
});

interface Invocation {
  readonly invocationId: string;
  readonly status: string;
  readonly result?: unknown;
  readonly inputRequests?: readonly {
    readonly requestId: string;
    readonly options?: readonly { readonly id: string }[];
  }[];
}

async function callTool(
  serverUrl: string,
  name: string,
  args: Record<string, unknown>,
  principal = "alice",
): Promise<Invocation> {
  const response = await fetch(new URL("/delegate/mcp", serverUrl), {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "x-principal": principal,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly result?: { readonly isError?: boolean; readonly structuredContent?: Invocation };
  };
  expect(body.result?.isError).not.toBe(true);
  const invocation = body.result?.structuredContent;
  if (invocation === undefined) throw new Error(`Missing invocation result from ${name}.`);
  return invocation;
}

async function readUntilStatus(
  serverUrl: string,
  invocationId: string,
  status: string,
  principal = "alice",
): Promise<Invocation> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const invocation = await callTool(serverUrl, "agent_get", { invocationId }, principal);
    if (invocation.status === status) return invocation;
    if (["completed", "failed", "cancelled"].includes(invocation.status)) {
      throw new Error(`Invocation reached ${invocation.status} before ${status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for invocation status ${status}.`);
}

async function readUntilTerminal(
  serverUrl: string,
  invocationId: string,
  principal = "alice",
): Promise<Invocation> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const invocation = await callTool(serverUrl, "agent_get", { invocationId }, principal);
    if (["completed", "failed", "cancelled"].includes(invocation.status)) return invocation;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for terminal invocation state.");
}
