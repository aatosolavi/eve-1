import { randomUUID } from "node:crypto";

import {
  createAttemptId,
  createClockDomainId,
  createProcessInstanceId,
  createSampleId,
  type HostRole,
  type RecordActor,
  type RuntimeKind,
} from "#internal/loop-benchmark/contract.js";
import {
  readLoopBenchmarkRecordPath,
  readLoopBenchmarkTarget,
} from "#internal/loop-benchmark/config.js";
import { JsonlRawRecordWriter } from "#internal/loop-benchmark/jsonl-records.js";
import { LoopBenchmarkRecorder } from "#internal/loop-benchmark/recorder.js";

const processInstanceId = createProcessInstanceId(
  `loop-benchmark:${String(process.pid)}:${randomUUID()}`,
);
const clockDomainId = createClockDomainId(`${processInstanceId}:monotonic`);

export function createLoopBenchmarkRecorder(
  input: {
    readonly actor: RecordActor;
    readonly attempt: string;
    readonly hostRole: HostRole;
    readonly runtime: RuntimeKind;
    readonly sampleId: string | undefined;
  },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LoopBenchmarkRecorder | undefined {
  const path = readLoopBenchmarkRecordPath(environment);
  const sampleId = input.sampleId?.trim();
  if (path === undefined || sampleId === undefined || sampleId === "") return undefined;

  const region = environment.VERCEL_REGION?.trim();
  const hostWithoutRegion = {
    id: `${input.hostRole}:${String(process.pid)}`,
    role: input.hostRole,
    target: readLoopBenchmarkTarget(environment),
  };
  return new LoopBenchmarkRecorder({
    clock: { now: () => performance.now() },
    scope: {
      actor: input.actor,
      attemptId: createAttemptId(input.attempt),
      clockDomainId,
      host:
        region === undefined || region === ""
          ? hostWithoutRegion
          : { ...hostWithoutRegion, region },
      processInstanceId,
      runtime: input.runtime,
      sampleId: createSampleId(sampleId),
    },
    writer: new JsonlRawRecordWriter(path),
  });
}

export async function recordLoopBenchmarkInterval<T>(
  recorder: LoopBenchmarkRecorder | undefined,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  return recorder === undefined
    ? await run()
    : await recorder.interval({ name, role: "leaf" }, run);
}

export function scheduleLoopBenchmarkRecorderFlush(
  recorder: LoopBenchmarkRecorder | undefined,
): void {
  try {
    void recorder?.flush().catch(() => {});
  } catch {
    // Benchmark telemetry must not change the measured runtime outcome.
  }
}
