import { inspect } from "node:util";

import type { Event } from "#compiled/@workflow/world/index.js";
import type { DecodedPersistedSessionEvent } from "#internal/dev-logs/event-timing.js";
import type { DevelopmentLogEvent } from "#internal/dev-logs/protocol.js";

export const WORKFLOW_EVENT_MARKER = /^\[[^\]]+\] \[workflow-complete\] event=([^\s]+)$/gmu;
export const SESSION_EVENT_MARKER =
  /^\[[^\]]+\] \[eve-event-complete\] run=([^\s]+) chunk=(\d+) line=(\d+)$/gmu;

export function compareWorkflowEvents(left: Event, right: Event): number {
  const byTime = left.createdAt.getTime() - right.createdAt.getTime();
  return byTime === 0 ? left.eventId.localeCompare(right.eventId) : byTime;
}

export function formatWorkflowEvent(
  event: Event,
  metrics: Readonly<Record<string, number>>,
): string {
  const timestamp = (event.occurredAt ?? event.createdAt).toISOString();
  return [
    `[${timestamp}] [workflow] event=${event.eventId} run=${event.runId} type=${event.eventType}${formatMetrics(metrics)}`,
    formatFullValue(event),
    `[${timestamp}] [workflow-complete] event=${event.eventId}`,
    "",
  ].join("\n");
}

export function formatSessionEvent(
  input: DecodedPersistedSessionEvent & {
    readonly chunkIndex: number;
    readonly lineIndex: number;
    readonly metrics: Readonly<Record<string, number>>;
    readonly runId: string;
  },
): string {
  const timestamp = input.event?.meta.at ?? new Date().toISOString();
  const type = input.event?.type ?? "invalid";
  const value = input.event ?? { error: input.error, source: input.source };
  return [
    `[${timestamp}] [eve-event] run=${input.runId} chunk=${String(input.chunkIndex)} line=${String(input.lineIndex)} type=${type}${formatMetrics(input.metrics)}`,
    formatFullValue(value),
    `[${timestamp}] [eve-event-complete] run=${input.runId} chunk=${String(input.chunkIndex)} line=${String(input.lineIndex)}`,
    "",
  ].join("\n");
}

export function formatOutputEvent(event: DevelopmentLogEvent): string {
  const source =
    event.type === "process.output"
      ? `${event.process}.${event.stream}`
      : `sandbox.${event.stream} sandbox=${event.sandboxId}`;
  const correlation = event.sessionId === undefined ? "" : ` session=${event.sessionId}`;
  const terminated = event.text.endsWith("\n") ? event.text : `${event.text}\n`;
  return `[${event.at}] [${source}]${correlation}\n${terminated}\n`;
}

export function sessionEventKey(runId: string, chunkIndex: number, lineIndex: number): string {
  return `${runId}:${String(chunkIndex)}:${String(lineIndex)}`;
}

function formatMetrics(metrics: Readonly<Record<string, number>>): string {
  return Object.entries(metrics)
    .map(([key, value]) => ` ${key}=${String(value)}`)
    .join("");
}

function formatFullValue(value: unknown): string {
  return inspect(value, {
    breakLength: 120,
    colors: false,
    compact: false,
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
  });
}
