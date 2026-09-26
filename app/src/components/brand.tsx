/**
 * The Mandate mark: an M whose middle stroke is a check. The two uprights are the parties'
 * obligations, the check is the period that was met and paid. Fixed colours (not theme tokens)
 * so the mark looks the same wherever it appears: here, the favicon, app icons and share cards.
 */
export const BRAND = { tile: "#133b2c", tileLight: "#1d5a42", tileDark: "#0f3325", stroke: "#f1f6f2", check: "#3ddc91" } as const;

/** The mark's strokes on a 32-unit grid (shared with icon.svg, the app icon and the share cards). */
export const MARK_PATHS = { left: "M9.4 23V9", right: "M22.6 23V9", check: "M12.3 15.3 15.7 19.9 22.6 9" } as const;

export function Mark({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} style={{ display: "block", flex: "none" }}>
      {title && <title>{title}</title>}
      <rect width="32" height="32" rx="8" fill={BRAND.tile} />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.8">
        <path d={MARK_PATHS.left} stroke={BRAND.stroke} />
        <path d={MARK_PATHS.right} stroke={BRAND.stroke} />
        <path d={MARK_PATHS.check} stroke={BRAND.check} />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <span className="brand">
      <Mark size={size} />
      <span>Mandate</span>
    </span>
  );
}
