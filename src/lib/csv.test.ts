import { describe, expect, it } from "vitest";
import { parseCustomers, toCsv } from "./csv";

describe("customer CSV", () => {
  it("parses name,seats with a header, quotes and blank lines", () => {
    const { customers, errors } = parseCustomers('name,seats\nAcme Inc,2\n\n"Globex, LLC",1\n');
    expect(errors).toEqual([]);
    expect(customers).toEqual([{ name: "Acme Inc", seats: 2 }, { name: "Globex, LLC", seats: 1 }]);
  });
  it("still accepts the bare seat list", () => {
    expect(parseCustomers("1, 1, 3").customers.map((c) => c.seats)).toEqual([1, 1, 3]);
  });
  it("reports bad rows with their line number instead of guessing", () => {
    const { customers, errors } = parseCustomers("name,seats\nAcme,2\nInitech,2.5\n,4");
    expect(customers).toEqual([{ name: "Acme", seats: 2 }]);
    expect(errors).toEqual(['Line 3: "2.5" is not a positive whole number of seats', "Line 4: missing customer name"]);
  });
  it("round-trips through toCsv", () => {
    const csv = toCsv([{ name: "Globex, LLC", seats: 1 }]);
    expect(csv).toBe('name,seats\n"Globex, LLC",1\n');
    expect(parseCustomers(csv).customers).toEqual([{ name: "Globex, LLC", seats: 1 }]);
  });
  it("neutralises spreadsheet formulas in text but keeps negative numbers", () => {
    expect(toCsv([{ name: '=HYPERLINK("http://x")', delta: -12.5 }])).toBe(`name,delta\n"'=HYPERLINK(""http://x"")",-12.5\n`);
    expect(toCsv([{ name: "@SUM(A1)" }, { name: "-1+2" }])).toBe("name\n'@SUM(A1)\n'-1+2\n");
  });
});
