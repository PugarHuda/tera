// Two-column customer CSV: "name,seats" (header optional, quotes allowed). Also accepts a bare list "1, 1, 3", or one
// seat count per line.
export type CsvCustomer = { name: string; seats: number };

const cells = (line: string, sep: string) =>
  [...line.matchAll(new RegExp(`\\s*("((?:[^"]|"")*)"|[^${sep}]*)\\s*(?:${sep}|$)`, "g"))].map((m) => (m[2] ?? m[1]).replace(/""/g, '"').trim()).slice(0, -1);

// Seat counts are written in digits: Number() would also take "0x10", "1e2" or " 5 " as 16, 100 and 5 (QA).
const MAX_SEATS = 1_000_000; // validate.ts parseMigration
const MAX_NAME = 200;
const seatCount = (raw: string | undefined) => (raw !== undefined && /^\+?\d+$/.test(raw) ? Number(raw) : NaN);
const seatError = (where: string, raw: string | undefined) => {
  const n = seatCount(raw);
  return Number.isInteger(n) && n > MAX_SEATS ? `${where}: ${raw} seats is over the limit of ${MAX_SEATS.toLocaleString("en-US")}` : `${where}: "${raw ?? ""}" is not a positive whole number of seats`;
};
const okSeats = (n: number) => Number.isInteger(n) && n > 0 && n <= MAX_SEATS;

export function parseCustomers(text: string): { customers: CsvCustomer[]; errors: string[] } {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean); // CR-only files too (classic Mac Excel)
  const errors: string[] = [];
  // Bare list of seat counts on one line (the original planner input).
  // Signs count too: "1, 2, -3" is a bad seat list, not a customer named "1" with 2 seats.
  // One seat count per line (a pasted spreadsheet column, optionally headed "seats") is the same list.
  const column = /^seats$/i.test(lines[0] ?? "") ? lines.slice(1) : lines;
  const oneLine = lines.length === 1 && /^[-+\d\s,.]+$/.test(lines[0]);
  if (oneLine || (column.length > 0 && column.every((l) => /^[-+\d.]+$/.test(l)))) {
    const raw = (oneLine ? lines[0].split(/[\s,]+/) : column).filter(Boolean);
    raw.forEach((r, i) => !okSeats(seatCount(r)) && errors.push(seatError(`Item ${i + 1}`, r)));
    return { customers: raw.map((r, i) => ({ name: `customer ${i + 1}`, seats: seatCount(r) })), errors };
  }
  // European spreadsheets export with semicolons, some tools with tabs: the separator is the one the first line uses.
  const first = lines[0] ?? "";
  const sep = first.includes(",") ? "," : first.includes(";") ? ";" : first.includes("\t") ? "\t" : ",";
  const head = cells(first, sep).map((c) => c.toLowerCase());
  // A header may list the columns either way round.
  const swapped = head[0] === "seats" && head[1] === "name";
  const customers: CsvCustomer[] = [];
  lines.forEach((line, i) => {
    if (i === 0 && head.includes("name") && head.includes("seats")) return; // header
    const row = cells(line, sep);
    const [name, seatsRaw] = swapped ? [row[1], row[0]] : row;
    const seats = seatCount(seatsRaw);
    if (!name) errors.push(`Line ${i + 1}: missing customer name`);
    else if (name.length > MAX_NAME) errors.push(`Line ${i + 1}: the name is longer than ${MAX_NAME} characters`);
    else if (!okSeats(seats)) errors.push(seatError(`Line ${i + 1}`, seatsRaw));
    else customers.push({ name, seats });
  });
  return { customers, errors };
}

// Excel reads a CSV as the system code page unless it starts with a UTF-8 byte order mark.
export const csvBlob = (csv: string) => new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });

export const toCsv = (rows: Array<Record<string, string | number>>) => {
  if (rows.length === 0) return "";
  // OWASP CSV injection: text starting with = + - @ (or tab/CR) would run as a spreadsheet formula.
  const cell = (v: string | number) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v));
  const esc = (v: string | number) => (/[",\r\n]/.test(cell(v)) ? `"${cell(v).replace(/"/g, '""')}"` : cell(v));
  const keys = Object.keys(rows[0]);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
};
