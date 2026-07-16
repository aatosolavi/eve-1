import { describe, expect, it } from "vitest";

import {
  createSandboxOutputObserver,
  listenToSandboxOutput,
} from "#execution/sandbox/output-events.js";

describe("sandbox output events", () => {
  it("isolates sandbox execution from listener failures", () => {
    const events: string[] = [];
    const stopFailingListener = listenToSandboxOutput(() => {
      throw new Error("log writer failed");
    });
    const stopListener = listenToSandboxOutput((event) => events.push(event.text));
    const observer = createSandboxOutputObserver("sbx_weather");

    try {
      expect(() => observer.write("stdout", "hello\n")).not.toThrow();
    } finally {
      stopFailingListener();
      stopListener();
    }

    expect(events).toEqual(["hello\n"]);
  });

  it("preserves UTF-8 characters split across backend chunks", () => {
    const text: string[] = [];
    const stopListening = listenToSandboxOutput((event) => text.push(event.text));
    const observer = createSandboxOutputObserver("sbx_weather");
    const bytes = new TextEncoder().encode("sunny 🌤️\n");

    try {
      observer.write("stdout", bytes.subarray(0, 8));
      observer.write("stdout", bytes.subarray(8, 11));
      observer.write("stdout", bytes.subarray(11));
      observer.close("stdout");
    } finally {
      stopListening();
    }

    expect(text.join("")).toBe("sunny 🌤️\n");
  });
});
