import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Mandate: market-making contracts enforced on Solana", template: "%s · Mandate" },
  description:
    "Hire a market maker and let the chain hold them to it. Inventory can only be quoted on Meteora DLMM, anyone can check the quotes, and the maker is paid per compliant period or loses its bond.",
  metadataBase: new URL("https://mandate-lac-rho.vercel.app"),
  openGraph: {
    title: "Mandate",
    description: "Market-making contracts enforced on Solana.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0c10" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
