import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name} — AI-first browser runtime`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background: "linear-gradient(135deg, #0a0f14 0%, #0f1a1f 45%, #0d1518 100%)",
          color: "#f4f7f8",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <div
            style={{
              width: "72px",
              height: "72px",
              borderRadius: "18px",
              background: "rgba(56, 189, 148, 0.15)",
              border: "1px solid rgba(56, 189, 148, 0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "36px",
              fontWeight: 700,
              color: "#38bd94",
            }}
          >
            V
          </div>
          <div style={{ fontSize: "42px", fontWeight: 700, letterSpacing: "-0.03em" }}>
            {SITE.name}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "900px" }}>
          <div
            style={{
              fontSize: "58px",
              fontWeight: 700,
              lineHeight: 1.1,
              letterSpacing: "-0.04em",
            }}
          >
            AI-first browser runtime
          </div>
          <div
            style={{
              fontSize: "28px",
              lineHeight: 1.45,
              color: "rgba(244, 247, 248, 0.72)",
            }}
          >
            CDP-native · MCP-ready · automation infrastructure without the Chromium monolith
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: "16px",
            fontSize: "22px",
            color: "rgba(56, 189, 148, 0.9)",
          }}
        >
          <span>velora.io</span>
          <span style={{ color: "rgba(244, 247, 248, 0.35)" }}>|</span>
          <span>AGPL-3.0</span>
        </div>
      </div>
    ),
    { ...size }
  );
}