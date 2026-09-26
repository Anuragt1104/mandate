/**
 * Shared drawing for the generated brand images (app icon, share cards). Rendered by next/og, so
 * only flexbox and inline SVG; the mark's geometry comes from components/brand.
 */
import { BRAND, MARK_PATHS } from "@/components/brand";

export function MarkSvg({ size, tile = true, radius = 8 }: { size: number; tile?: boolean; radius?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={BRAND.tileLight} />
          <stop offset="1" stopColor={BRAND.tileDark} />
        </linearGradient>
      </defs>
      {tile && <rect width="32" height="32" rx={radius} fill="url(#tile)" />}
      <path d={MARK_PATHS.left} stroke={BRAND.stroke} strokeWidth="3.8" strokeLinecap="round" fill="none" />
      <path d={MARK_PATHS.right} stroke={BRAND.stroke} strokeWidth="3.8" strokeLinecap="round" fill="none" />
      <path d={MARK_PATHS.check} stroke={BRAND.check} strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** Chivo from Google Fonts as TTF (what next/og can read); null if unreachable, so images still render. */
export async function chivo(weight: 500 | 700): Promise<ArrayBuffer | null> {
  try {
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Chivo:wght@${weight}&display=swap`)).text();
    const url = css.match(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/)?.[1];
    return url ? await (await fetch(url)).arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** The social card: the mark, the name, what it is, and a strip of scored periods. */
export async function shareCard() {
  const [regular, bold] = await Promise.all([chivo(500), chivo(700)]);
  const fonts = [regular && { name: "Chivo", data: regular, weight: 500 as const }, bold && { name: "Chivo", data: bold, weight: 700 as const }].filter(Boolean) as { name: string; data: ArrayBuffer; weight: 500 | 700 }[];
  // Scored periods, as on an agreement page: met, one missed and recovered, a few unchecked.
  const ticks = "mmmmmmmmmmmmm-mmmmmmmmmxmmmmmmmmmmmmmmmmmmm".split("");
  return {
    fonts,
    element: (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px", background: `linear-gradient(135deg, ${BRAND.tileLight} 0%, ${BRAND.tile} 45%, ${BRAND.tileDark} 100%)`, color: BRAND.stroke, fontFamily: fonts.length ? "Chivo" : "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div style={{ display: "flex", borderRadius: 26, boxShadow: "0 0 0 2px rgba(241,246,242,0.14)" }}>
            <MarkSvg size={104} />
          </div>
          <span style={{ fontSize: 60, fontWeight: 700, letterSpacing: "-0.04em" }}>Mandate</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <span style={{ fontSize: 64, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: 1.05, maxWidth: 980 }}>Accountable liquidity management on Solana</span>
          <span style={{ fontSize: 28, fontWeight: 500, color: "#a9c2b4", maxWidth: 1000, lineHeight: 1.3 }}>Restricted inventory permissions, verifiable service records and automatic settlement for market-making agreements.</span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {ticks.map((c, i) => (
              <div key={i} style={{ width: 11, height: 44, borderRadius: 3, background: c === "m" ? BRAND.check : c === "x" ? "#ff6a55" : "rgba(241,246,242,0.18)" }} />
            ))}
          </div>
          <span style={{ fontSize: 22, fontWeight: 500, color: "#a9c2b4" }}>mandate-lac-rho.vercel.app</span>
        </div>
      </div>
    ),
  };
}
