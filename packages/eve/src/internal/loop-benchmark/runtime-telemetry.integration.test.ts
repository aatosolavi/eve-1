import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recordWorkflowBenchmarkParkAcceptedStep } from "#execution/workflow-steps.js";
import {
  JsonlRawRecordWriter,
  readLoopBenchmarkJsonlRecords,
} from "#internal/loop-benchmark/jsonl-records.js";
import {
  createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval,
} from "#internal/loop-benchmark/runtime-telemetry.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createLoopBenchmarkRecorder", () => {
  it("stays disabled unless both the record path and sample id exist", () => {
    const common = {
      actor: "controller" as const,
      attempt: "attempt-1",
      hostRole: "controller" as const,
      runtime: "inline" as const,
    };

    expect(createLoopBenchmarkRecorder({ ...common, sampleId: "sample-1" }, {})).toBeUndefined();
    expect(
      createLoopBenchmarkRecorder(
        { ...common, sampleId: undefined },
        { EVE_LOOP_BENCHMARK_RECORD_PATH: "/tmp/records.jsonl" },
      ),
    ).toBeUndefined();
  });

  it("writes runtime-neutral intervals with runtime and target as dimensions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-loop-benchmark-telemetry-"));
    const path = join(directory, "records.jsonl");
    const recorder = createLoopBenchmarkRecorder(
      {
        actor: "controller",
        attempt: "attempt-1",
        hostRole: "controller",
        runtime: "workflow",
        sampleId: "sample-1",
      },
      {
        EVE_LOOP_BENCHMARK_RECORD_PATH: path,
        EVE_LOOP_BENCHMARK_TARGET: "vercel",
      },
    );
    if (recorder === undefined) throw new Error("Expected benchmark recorder.");

    await recordLoopBenchmarkInterval(recorder, "engine.dispatch", async () => undefined);
    await recorder.flush();

    const records = await readLoopBenchmarkJsonlRecords(path);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      host: { target: "vercel" },
      kind: "interval",
      name: "engine.dispatch",
      runtime: "workflow",
      sampleId: "sample-1",
    });
  });

  it("persists the Workflow post-rekey acceptance marks without inventing a duration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-loop-benchmark-telemetry-"));
    const path = join(directory, "records.jsonl");
    vi.stubEnv("EVE_LOOP_BENCHMARK_RECORD_PATH", path);

    await recordWorkflowBenchmarkParkAcceptedStep({ sampleId: "sample-workflow" });
    await new JsonlRawRecordWriter(path).flush();

    const records = await readLoopBenchmarkJsonlRecords(path);
    expect(records.flatMap((record) => (record.kind === "mark" ? [record.name] : []))).toEqual([
      "session.rekey.accepted",
      "runtime.park.accepted",
    ]);
    expect(
      records.some((record) => record.kind === "interval" && record.name === "session.rekey"),
    ).toBe(false);
  });
});
