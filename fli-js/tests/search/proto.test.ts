/**
 * Tests for the GetBookingResults protobuf token builder + tfu URL parser.
 *
 * The builder must reproduce a byte-perfect copy of the captured token —
 * any change to the encoder must keep the captured fixture passing.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  _readVarint,
  buildBookingToken,
  decodeBookingToken,
  extractBookingTokenFromTfu,
  extractSessionIdFromTfu,
} from "../../src/search/proto.ts";

// Captured live 2026-05-14 (JFK → LAX outbound AA171, return AA28, RT $346.80).
const CAPTURED_TOKEN =
  "CjRIUHJ1SE9pTmdoeUVBQ0U1S2dCRy0tLS0tLS0tLS1wZm4zOUFBQUFBR29GZ2tjSG5SRHdBEgZBQTI4IzEaCwj4jgIQAhoDVVNEOBxw+I4C";
const CAPTURED_SESSION = "HPruHOiNghyEACE5KgBG----------pfn39AAAAAGoFgkcHnRDwA";

function unpadBase64(token: string): string {
  const pad = (4 - (token.length % 4)) % 4;
  return token + "=".repeat(pad);
}

function decodeUrlsafe(token: string): Uint8Array {
  return new Uint8Array(
    Buffer.from(unpadBase64(token).replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  );
}

describe("buildBookingToken", () => {
  test("byte-perfect reproduction of captured token", () => {
    const built = buildBookingToken({
      sessionId: CAPTURED_SESSION,
      airlineCode: "AA",
      flightNumber: "28",
      legIndex: 1,
      priceCents: 34680,
      currency: "USD",
    });
    const bBuilt = new Uint8Array(Buffer.from(unpadBase64(built), "base64"));
    const bCapt = decodeUrlsafe(CAPTURED_TOKEN);
    expect(Buffer.from(bBuilt).toString("hex")).toBe(Buffer.from(bCapt).toString("hex"));
  });

  test("round-trip decode", () => {
    const token = buildBookingToken({
      sessionId: "ABC123",
      airlineCode: "DL",
      flightNumber: "100",
      legIndex: 1,
      priceCents: 12345,
      currency: "EUR",
    });
    const decoded = decodeBookingToken(token);
    expect(decoded.field_1).toBe("ABC123");
    expect(decoded.field_2).toBe("DL100#1");
    expect(decoded.field_3).toEqual({ field_1: 12345, field_2: 2, field_3: "EUR" });
    expect(decoded.field_7).toBe(28);
    expect(decoded.field_14).toBe(12345);
  });

  test.each(["USD", "EUR", "GBP", "JPY", "INR"])("currency %s round-trips", (code) => {
    const token = buildBookingToken({
      sessionId: "S",
      airlineCode: "DL",
      flightNumber: "1",
      legIndex: 1,
      priceCents: 100,
      currency: code,
    });
    const decoded = decodeBookingToken(token);
    expect((decoded.field_3 as Record<string, unknown>).field_3).toBe(code);
  });

  test.each([0, 1, 2, 5, 10])("leg index %d appears in field 2", (idx) => {
    const token = buildBookingToken({
      sessionId: "S",
      airlineCode: "AA",
      flightNumber: "100",
      legIndex: idx,
      priceCents: 100,
      currency: "USD",
    });
    const decoded = decodeBookingToken(token);
    expect(decoded.field_2).toBe(`AA100#${idx}`);
  });

  test("price varint encoding (3-byte case)", () => {
    const token = buildBookingToken({
      sessionId: "S",
      airlineCode: "AA",
      flightNumber: "1",
      legIndex: 1,
      priceCents: 34680,
      currency: "USD",
    });
    const decoded = decodeBookingToken(token);
    expect((decoded.field_3 as Record<string, unknown>).field_1).toBe(34680);
    expect(decoded.field_14).toBe(34680);
  });

  test("large price (>6 digits)", () => {
    const token = buildBookingToken({
      sessionId: "S",
      airlineCode: "AA",
      flightNumber: "1",
      legIndex: 1,
      priceCents: 1_234_567,
      currency: "USD",
    });
    const decoded = decodeBookingToken(token);
    expect((decoded.field_3 as Record<string, unknown>).field_1).toBe(1_234_567);
  });

  test("decode captured token", () => {
    const decoded = decodeBookingToken(CAPTURED_TOKEN);
    expect(decoded.field_1).toBe(CAPTURED_SESSION);
    expect(decoded.field_2).toBe("AA28#1");
    expect(decoded.field_3).toEqual({ field_1: 34680, field_2: 2, field_3: "USD" });
    expect(decoded.field_7).toBe(28);
    expect(decoded.field_14).toBe(34680);
  });
});

describe("buildBookingToken validation", () => {
  const cases: Array<{
    args: Parameters<typeof buildBookingToken>[0];
    match: string;
  }> = [
    {
      args: {
        sessionId: "S",
        airlineCode: "AA",
        flightNumber: "1",
        legIndex: 1,
        priceCents: -1,
        currency: "USD",
      },
      match: "price_cents must be non-negative",
    },
    {
      args: {
        sessionId: "",
        airlineCode: "AA",
        flightNumber: "1",
        legIndex: 1,
        priceCents: 100,
        currency: "USD",
      },
      match: "session_id must be non-empty",
    },
    {
      args: {
        sessionId: "S",
        airlineCode: "",
        flightNumber: "1",
        legIndex: 1,
        priceCents: 100,
        currency: "USD",
      },
      match: "airline_code must be non-empty",
    },
    {
      args: {
        sessionId: "S",
        airlineCode: "AA",
        flightNumber: "",
        legIndex: 1,
        priceCents: 100,
        currency: "USD",
      },
      match: "flight_number must be non-empty",
    },
    {
      args: {
        sessionId: "S",
        airlineCode: "AA",
        flightNumber: "1",
        legIndex: 1,
        priceCents: 100,
        currency: "",
      },
      match: "currency must be non-empty",
    },
  ];
  test.each(cases)("rejects bad input (%#)", ({ args, match }) => {
    expect(() => buildBookingToken(args)).toThrow(match);
  });
});

describe("_readVarint", () => {
  test.each<[Uint8Array, [number, number]]>([
    [new Uint8Array([0x00]), [0, 1]],
    [new Uint8Array([0x7f]), [127, 1]],
    [new Uint8Array([0x80, 0x01]), [128, 2]],
  ])("decodes correctly", (data, expected) => {
    expect(_readVarint(data, 0)).toEqual(expected);
  });

  test("truncated varint raises", () => {
    expect(() => _readVarint(new Uint8Array([0x80]), 0)).toThrow();
  });

  test("decodes values ≥ 2^31 without sign-bit corruption", () => {
    // Naive `|= <<` decoders break here: shift=28 yields a 5th byte whose
    // top bits land at bit 31+, which JavaScript's signed-32 bitwise ops
    // would render as a negative number.
    const cases: Array<[number, Uint8Array]> = [
      [2 ** 31, new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x08])],
      [2 ** 32, new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x10])],
      [2 ** 40, new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x20])],
    ];
    for (const [expected, bytes] of cases) {
      const [decoded] = _readVarint(bytes, 0);
      expect(decoded).toBe(expected);
    }
  });
});

// Live `tfu` URL parameter captured 2026-05-14 from a JFK→LAX RT booking page.
const LIVE_TFU =
  "CmxDalJJVVZwUk1FOUJjRVZyZEVWQlEzaFRkVkZDUnkwdExTMHRMUzB0TFhCcVltWjZOMEZCUVVGQlIyOUdPVlpGU0U5SVVXRkJFZ1pCUVRJNEl6RWFDd2o0amdJUUFob0RWVk5FT0J4dytJNEMSAggAIgA";
const LIVE_BOOKING_URL = `https://www.google.com/travel/flights/booking?tfs=CBwQAho_EgoyMDI2LTA3LTE1Ih8KA0pGSxIKMjAyNi0wNy0xNRoDTEFYKgJBQTIDMTcxagcIARIDSkZLcgcIARIDTEFYGj4SCjIwMjYtMDctMTkiHgoDTEFYEgoyMDI2LTA3LTE5GgNKRksqAkFBMgIyOGoHCAESA0xBWHIHCAESA0pGS0ABSAFwAYIBCwj___________8BmAEB&tfu=${LIVE_TFU}&hl=en&gl=US&curr=USD`;

describe("extractBookingTokenFromTfu", () => {
  test("extract from bare tfu value", () => {
    const token = extractBookingTokenFromTfu(LIVE_TFU);
    const decoded = decodeBookingToken(token);
    expect(decoded.field_2).toBe("AA28#1");
    expect((decoded.field_3 as Record<string, unknown>).field_3).toBe("USD");
  });

  test("extract from full booking URL", () => {
    const fromUrl = extractBookingTokenFromTfu(LIVE_BOOKING_URL);
    const fromBare = extractBookingTokenFromTfu(LIVE_TFU);
    expect(fromUrl).toBe(fromBare);
  });

  test("extract session id round-trips", () => {
    const session = extractSessionIdFromTfu(LIVE_TFU);
    expect(typeof session).toBe("string");
    expect(session.length).toBeGreaterThan(30);
    expect(session.startsWith("H")).toBe(true);
    expect(session.includes("-")).toBe(true);
  });

  test("URL without tfu param rejected", () => {
    expect(() =>
      extractBookingTokenFromTfu("https://www.google.com/travel/flights/booking?tfs=ABC&hl=en"),
    ).toThrow();
  });
});
