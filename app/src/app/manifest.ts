import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mandate",
    short_name: "Mandate",
    description: "Accountable liquidity management on Solana: restricted inventory permissions, verifiable service records and automatic settlement.",
    start_url: "/app",
    display: "standalone",
    background_color: "#0b0e0c",
    theme_color: "#133b2c",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
