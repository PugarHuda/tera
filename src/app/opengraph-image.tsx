import { ImageResponse } from "next/og";
import evidence from "../../golden/parity/index.json";

export const alt = "Tera: preview every invoice before you change your pricing, proven against Stripe";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The headline number comes from the committed Stripe evidence, not from copy.
const matched = evidence.filter((e) => e.match).length;

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#0a0a0a", color: "#ededed", fontSize: 32 }}>
        <div style={{ display: "flex", fontSize: 72, fontWeight: 700 }}>Tera</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", fontSize: 56, fontWeight: 600, lineHeight: 1.15 }}>See every invoice to the cent before you change your pricing.</div>
          <div style={{ display: "flex", color: "#4ade80" }}>
            Verified: {matched} / {evidence.length} billing scenarios match Stripe test mode line by line
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.7, fontSize: 26 }}>
          <span>Prorations · coupons · trials · tax · metered tiers · credit balance</span>
          <span>Tested on every PR by TestSprite</span>
        </div>
      </div>
    ),
    size,
  );
}
