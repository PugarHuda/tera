// Two-column customer CSV: "name,seats" (header optional, quotes allowed). Also accepts a bare list "1, 1, 3".
export type CsvCustomer = { name: string; seats: number };

const cells = (line: string) => [...line.matchAll(/\s*("((?:[^"]|"")*)"|[^,]*)\s*(?:,|$)/g)].map((m) => (m[2] ?? m[1]).replace(/""/g, '"').trim()).slice(0, -1);

export function parseCustomers(text: string): { customers: CsvCustomer[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errors: string[] = [];
  // Bare list of seat counts on one line (the original planner input).
  if (lines.length === 1 && /^[\d\s,.]+$/.test(lines[0])) {
    const seats = lines[0].split(/[\s,]+/).filter(Boolean).map(Number);
    seats.forEach((s, i) => !(Number.isInteger(s) && s > 0) && errors.push(`Item ${i + 1}: "${s}" is not a positive whole number of seats`));
    return { customers: seats.map((s, i) => ({ name: `customer ${i + 1}`, seats: s })), errors };
  }
  const customers: CsvCustomer[] = [];
  lines.forEach((line, i) => {
    const [name, seatsRaw] = cells(line);
    if (i === 0 && /^name$/i.test(name ?? "") && /^seats$/i.test(seatsRaw ?? "")) return; // header
    const seats = Number(seatsRaw);
    if (!name) errors.push(`Line ${i + 1}: missing customer name`);
    else if (!(Number.isInteger(seats) && seats > 0)) errors.push(`Line ${i + 1}: "${seatsRaw ?? ""}" is not a positive whole number of seats`);
    else customers.push({ name, seats });
  });
  return { customers, errors };
}

export const toCsv = (rows: Array<Record<string, string | number>>) => {
  if (rows.length === 0) return "";
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const keys = Object.keys(rows[0]);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
};
