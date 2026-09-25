import type { Metadata, Viewport } from "next";
import { Chivo, Chivo_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const chivo = Chivo({ subsets: ["latin"], variable: "--font-chivo", display: "swap" });
const chivoMono = Chivo_Mono({ subsets: ["latin"], variable: "--font-chivo-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Mandate: liquidity SLAs for token markets", template: "%s · Mandate" },
  description:
    "Put a token's market maker under a liquidity SLA on Solana. Quotes are checked at random by anyone, every period is scored on-chain, and a maker who stops quoting loses its bond.",
  metadataBase: new URL("https://mandate-lac-rho.vercel.app"),
  openGraph: {
    title: "Mandate",
    description: "Uptime for token markets: liquidity SLAs enforced on Solana.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f4f1" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e0c" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${chivo.variable} ${chivoMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
