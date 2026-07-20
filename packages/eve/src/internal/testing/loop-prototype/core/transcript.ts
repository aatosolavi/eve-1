import {
  createBalancedHistory,
  type BalancedHistory,
  type HistoryMessage,
  type OpenExchange,
  type RequestResult,
  type UserMessage,
} from "./types.js";

export function emptyHistory(): BalancedHistory {
  return createBalancedHistory([]);
}

export function appendUser(history: BalancedHistory, content: string): BalancedHistory {
  const message: UserMessage = { content, role: "user" };
  return createBalancedHistory([...history, message]);
}

export function openExchange(input: Omit<OpenExchange, "results">): OpenExchange {
  const requestIds = input.requests.map((request) => request.requestId);
  if (
    new Set(requestIds).size !== requestIds.length ||
    input.assistant.requestIds.length !== requestIds.length ||
    input.assistant.requestIds.some((requestId, index) => requestId !== requestIds[index])
  ) {
    throw new Error("Assistant request IDs do not match the ordered request list.");
  }

  return {
    ...input,
    results: input.requests.map(() => null),
  };
}

export function resolveExchangeRequest(
  exchange: OpenExchange,
  result: RequestResult,
): OpenExchange {
  const index = exchange.requests.findIndex((request) => request.requestId === result.requestId);

  if (index === -1) {
    throw new Error(`Unknown request "${result.requestId}".`);
  }

  if (exchange.results[index] !== null) {
    throw new Error(`Request "${result.requestId}" already has a result.`);
  }

  return {
    ...exchange,
    results: exchange.results.map((current, currentIndex) =>
      currentIndex === index ? result : current,
    ),
  };
}

export function closeExchange(
  history: BalancedHistory,
  exchange: OpenExchange,
): BalancedHistory | null {
  if (exchange.results.some((result) => result === null)) return null;

  const messages: HistoryMessage[] = [exchange.assistant];

  for (const result of exchange.results) {
    if (result === null) throw new Error("Resolved exchange contains a missing result.");

    messages.push({
      content: result.value,
      isError: result.isError,
      requestId: result.requestId,
      role: "tool",
    });
  }

  return createBalancedHistory([...history, ...messages]);
}

export function lastUserMessage(history: BalancedHistory): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role === "user") return message.content;
  }

  throw new Error("History has no user message.");
}

export function resultsAfterLastUser(history: BalancedHistory): readonly RequestResult[] {
  const results: RequestResult[] = [];

  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role === "user") break;
    if (message?.role !== "tool") continue;

    results.unshift({
      isError: message.isError,
      requestId: message.requestId,
      value: message.content,
    });
  }

  return results;
}
