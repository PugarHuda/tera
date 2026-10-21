import { ImageResponse } from "next/og";
import evidence from "../../golden/parity/index.json";

export const alt = "Tera: preview every invoice before you change your pricing, proven against Stripe";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The numbers come from the committed Stripe evidence, not from copy.
const records = evidence as { match: boolean; stripe: unknown[]; webhooks?: string[][] }[];
const matched = records.filter((e) => e.match).length;
const invoices = records.reduce((n, r) => n + r.stripe.length, 0);
const webhooks = records.reduce((n, r) => n + (r.webhooks?.flat().length ?? 0), 0);
const STRIPES = ["#f6a04a", "#f57411", "#db1405", "#500302"];

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", padding: 28, background: "#020202" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", borderRadius: 24, overflow: "hidden", background: "#fdfdfd", color: "#020202" }}>
          <div style={{ display: "flex", flexDirection: "column", padding: "48px 56px 0", gap: 18 }}>
            <div style={{ display: "flex", fontSize: 22, fontWeight: 700, letterSpacing: 3, color: "#b31004" }}>— TERA · STRIPE-PARITY BILLING SIMULATOR —</div>
            <div style={{ display: "flex", fontSize: 64, fontWeight: 600, lineHeight: 1.08, letterSpacing: -1.5 }}>Change your pricing without breaking a single invoice.</div>
          </div>
          <div style={{ display: "flex", gap: 20, padding: "0 56px" }}>
            {[
              [`${matched} / ${records.length}`, "timelines match Stripe test clocks"],
              [invoices.toLocaleString("en-US"), "invoices compared line by line"],
              [webhooks.toLocaleString("en-US"), "webhook events predicted"],
            ].map(([n, label]) => (
              <div key={label} style={{ flex: 1, display: "flex", flexDirection: "column", padding: "16px 22px", borderRadius: 16, border: "2px dashed #c9c6c2", background: "#f6f5f3" }}>
                <span style={{ fontSize: 44, fontWeight: 600 }}>{n}</span>
                <span style={{ fontSize: 20, color: "#5b5b5b" }}>{label}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {STRIPES.map((c) => (
              <div key={c} style={{ display: "flex", height: 14, background: c }} />
            ))}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
