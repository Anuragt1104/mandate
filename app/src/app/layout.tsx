import type { Metadata, Viewport } from "next";
import { Chivo, Chivo_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const chivo = Chivo({ subsets: ["latin"], variable: "--font-chivo", display: "swap" });
const chivoMono = Chivo_Mono({ subsets: ["latin"], variable: "--font-chivo-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Mandate: accountable liquidity management on Solana", template: "%s · Mandate" },
  description:
    "Hire a liquidity manager without handing over your tokens. Inventory sits in a vault the manager can only quote from, the manager posts a bond, and every period is checked in public and settled automatically.",
  metadataBase: new URL("https://mandate-lac-rho.vercel.app"),
  openGraph: {
    title: "Mandate",
    description: "Accountable liquidity management: restricted custody and automatic settlement for market-making agreements.",
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
