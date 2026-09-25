import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/ui";

export const metadata: Metadata = {
  title: "Mandate",
  description: "Market-making contracts enforced on Solana: deploy-only vaults, on-chain scoring, pay for compliance, slash on breach.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <main className="shell">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
