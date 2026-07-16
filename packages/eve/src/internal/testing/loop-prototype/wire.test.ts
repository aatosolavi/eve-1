import { describe, expect, it } from "vitest";

import { decodeWireEnvelope, encodeWireEnvelope, stringifyCanonical } from "./wire.js";

describe("prototype wire codec", () => {
  it("round-trips the shared JSON subset", () => {
    const value = { children: ["one", "two"], revision: 3 } as const;
    expect(decodeWireEnvelope(JSON.parse(JSON.stringify(encodeWireEnvelope(value))))).toEqual(
      value,
    );
  });

  it("rejects unknown versions at the boundary", () => {
    expect(() => decodeWireEnvelope({ codec: "eve-json", value: null, version: 2 })).toThrow(
      'unsupported version "2"',
    );
  });

  it("canonicalizes object keys for protocol equality", () => {
    expect(stringifyCanonical({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stringifyCanonical({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});
