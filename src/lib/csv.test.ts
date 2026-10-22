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
  it("takes seat counts only in digits (QA: 0x10 and 1e2 were read as 16 and 100)", () => {
    const { customers, errors } = parseCustomers("name,seats\nAcme,0x10\nB,1e2\nC, 5");
    expect(customers).toEqual([{ name: "C", seats: 5 }]);
    expect(errors).toEqual(['Line 2: "0x10" is not a positive whole number of seats', 'Line 3: "1e2" is not a positive whole number of seats']);
  });
  it("names the limit a row breaks", () => {
    expect(parseCustomers(`Acme,2000000\n${"x".repeat(201)},1`).errors).toEqual(["Line 1: 2000000 seats is over the limit of 1,000,000", "Line 2: the name is longer than 200 characters"]);
  });
  it("reads semicolon and tab separated exports, CR-only line breaks and swapped header columns", () => {
    const want = [{ name: "Acme", seats: 12 }, { name: "Globex", seats: 3 }];
    expect(parseCustomers("name;seats\nAcme;12\nGlobex;3")).toEqual({ customers: want, errors: [] });
    expect(parseCustomers("name\tseats\rAcme\t12\rGlobex\t3")).toEqual({ customers: want, errors: [] });
    expect(parseCustomers("seats,name\n12,Acme\n3,Globex")).toEqual({ customers: want, errors: [] });
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

describe("parseCustomers: one seat count per line", () => {
  it("reads a column of seats, with or without a header", () => {
    expect(parseCustomers("1\n2\n3").customers.map((c) => c.seats)).toEqual([1, 2, 3]);
    expect(parseCustomers("seats\n3\n4")).toEqual({ customers: [{ name: "customer 1", seats: 3 }, { name: "customer 2", seats: 4 }], errors: [] });
  });
  it("names the bad value in the column", () => expect(parseCustomers("1\n0\n2").errors).toEqual(['Item 2: "0" is not a positive whole number of seats']));
});
