import { describe, expect, it } from "vitest";
import { normalizeAnswer, parseMoney } from "../src/bank/normalize.js";

const ok = (value: string) => ({ ok: true, value });

describe("normalizeAnswer", () => {
  it("lets you clear any field", () => {
    expect(normalizeAnswer("money", "  ")).toEqual(ok(""));
  });

  it("text: trims and collapses spaces", () => {
    expect(normalizeAnswer("text", "  Tamil   Nadu ")).toEqual(
      ok("Tamil Nadu"),
    );
  });

  it.each([
    ["y", "Yes"],
    ["YES", "Yes"],
    ["true", "Yes"],
    ["no", "No"],
    ["N", "No"],
  ])("yesno: %s → %s", (raw, value) => {
    expect(normalizeAnswer("yesno", raw)).toEqual(ok(value));
  });

  it("yesno: rejects anything else", () => {
    expect(normalizeAnswer("yesno", "maybe")).toMatchObject({ ok: false });
  });

  it("list: trims, drops empties and duplicates", () => {
    expect(normalizeAnswer("list", "Tamil, English,, tamil\nHindi")).toEqual(
      ok("Tamil, English, Hindi"),
    );
  });

  it.each([
    ["2026-11-20", "2026-11-20"],
    ["20/11/2026", "2026-11-20"],
    ["20-11-2026", "2026-11-20"],
    ["20 Nov 2026", "2026-11-20"],
    ["November 20, 2026", "2026-11-20"],
  ])("date: %s → %s", (raw, value) => {
    expect(normalizeAnswer("date", raw)).toEqual(ok(value));
  });

  it("date: rejects what isn't a date", () => {
    expect(normalizeAnswer("date", "soon")).toMatchObject({
      ok: false,
      error: expect.stringContaining("YYYY-MM-DD"),
    });
  });

  it.each([
    ["30", "30"],
    ["30 days", "30"],
    ["1 month", "30"],
    ["2 months", "60"],
    ["4 weeks", "28"],
    ["Immediate", "0"],
    ["immediately", "0"],
  ])("days: %s → %s", (raw, value) => {
    expect(normalizeAnswer("days", raw)).toEqual(ok(value));
  });

  it("days: rejects nonsense and silly values", () => {
    expect(normalizeAnswer("days", "a while")).toMatchObject({ ok: false });
    expect(normalizeAnswer("days", "900")).toMatchObject({ ok: false });
  });

  it.each([
    ["6", "6"],
    ["6 years", "6"],
    ["6+", "6"],
    ["6.5", "6.5"],
  ])("number: %s → %s", (raw, value) => {
    expect(normalizeAnswer("number", raw)).toEqual(ok(value));
  });

  it.each([
    ["INR 3000000", "INR 3000000"],
    ["3000000", "INR 3000000"],
    ["30 LPA", "INR 3000000"],
    ["30 lakhs", "INR 3000000"],
    ["₹30,00,000", "INR 3000000"],
    ["1.2 Cr", "INR 12000000"],
    ["EUR 70000", "EUR 70000"],
    ["€70k", "EUR 70000"],
    ["$120,000", "USD 120000"],
    ["£65000", "GBP 65000"],
    ["sgd 90000", "SGD 90000"],
  ])("money: %s → %s", (raw, value) => {
    expect(normalizeAnswer("money", raw, { defaultCurrency: "INR" })).toEqual(
      ok(value),
    );
  });

  it("money: needs a currency when there is no default", () => {
    expect(normalizeAnswer("money", "3000000")).toMatchObject({
      ok: false,
      error: expect.stringContaining("currency"),
    });
  });
});

describe("parseMoney", () => {
  it("reads the stored form back", () => {
    expect(parseMoney("INR 3000000")).toEqual({
      currency: "INR",
      amount: 3000000,
    });
    expect(parseMoney("rubbish")).toBeNull();
  });
});
