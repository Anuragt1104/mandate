import { ImageResponse } from "next/og";
import { shareCard } from "./brand-image";

export const alt = "Mandate: accountable liquidity management on Solana";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function TwitterImage() {
  const { element, fonts } = await shareCard();
  return new ImageResponse(element, { ...size, fonts });
}
