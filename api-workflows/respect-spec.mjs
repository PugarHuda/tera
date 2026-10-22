// Prepares a downloaded /api/openapi.json for Redocly Respect: Respect checks responses with Ajv's
// defaultUnevaluatedProperties: false, which makes every subschema without its own setting strict, so a conditional
// branch (if/then/else, allOf/oneOf/anyOf members) would reject the properties its parent declares. The branches get
// an explicit unevaluatedProperties: true here, not in the served spec: Schemathesis cannot generate cases from it.
// Usage: node api-workflows/respect-spec.mjs openapi.json   (rewrites the file in place)
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2] ?? "openapi.json";
const spec = JSON.parse(readFileSync(file, "utf8"));
const open = (s) => s && typeof s === "object" && !("$ref" in s) && (s.unevaluatedProperties ??= true);
(function walk(node) {
  if (!node || typeof node !== "object") return;
  for (const k of ["if", "then", "else", "not"]) open(node[k]);
  for (const k of ["allOf", "oneOf", "anyOf"]) if (Array.isArray(node[k])) node[k].forEach(open);
  Object.values(node).forEach(walk);
})(spec);
writeFileSync(file, JSON.stringify(spec));
