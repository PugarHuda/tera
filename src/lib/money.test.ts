import { describe, expect, it } from "vitest";
import { formatMoney, minorDigits } from "./billing";
import { minorOf } from "./money";

const fmt = (a: number, c: string) => formatMoney(a, c).replace(/ /g, " ");

// Stripe's minor units (docs.stripe.com/currencies), where they differ from ISO 4217 / Intl.
describe("Stripe minor units", () => {
  it.each([["usd", 2], ["jpy", 0], ["krw", 0], ["vnd", 0], ["idr", 2], ["huf", 2], ["isk", 2], ["ugx", 2], ["twd", 2], ["kwd", 3], ["bhd", 3]])("%s has %i", (c, d) =>
    expect(minorDigits(c as string)).toBe(d));
  it("formats Stripe amounts, not ISO ones", () => {
    expect(fmt(1000000, "idr")).toBe("IDR 10,000"); // Stripe 1000000 = Rp10,000.00; Intl alone said IDR 1,000,000
    expect(fmt(1000050, "idr")).toBe("IDR 10,000.50");
    expect(fmt(50000, "isk")).toBe("ISK 500"); // "to charge 5 ISK, provide 500"
    expect(fmt(17500, "huf")).toBe("HUF 175"); // Stripe's 175.00 HUF minimum charge
    expect(fmt(2900, "usd")).toBe("$29.00");
    expect(fmt(3000, "jpy")).toBe("¥3,000");
    expect(fmt(1500, "kwd")).toBe("KWD 1.500");
  });
  it("parses typed amounts into Stripe's minor units", () => {
    expect(minorOf("10000", "idr", "p")).toBe(1000000);
    expect(minorOf("10000.50", "idr", "p")).toBe(1000050);
    expect(minorOf("500", "isk", "p")).toBe(50000);
    expect(minorOf("5.5", "isk", "p")).toMatch(/cannot have decimals/);
    expect(minorOf("3000.5", "jpy", "p")).toMatch(/cannot have decimals/);
  });
});
