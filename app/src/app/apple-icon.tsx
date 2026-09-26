import { ImageResponse } from "next/og";
import { MarkSvg } from "./brand-image";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: full bleed (iOS rounds the corners itself). */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        <MarkSvg size={180} radius={0} />
      </div>
    ),
    size,
  );
}
