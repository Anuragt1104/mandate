/**
 * The Mandate mark: an ask above and a bid below, held apart by the reference line.
 * It is the product's rule drawn as a logo: asks at or above, bids at or below.
 */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" style={{ display: "block", flex: "none" }}>
      <rect width="26" height="26" rx="7" fill="var(--ink)" />
      <rect x="11" y="6" width="9" height="4.2" rx="1.4" fill="var(--surface)" />
      <rect x="4.5" y="12.2" width="17" height="1.6" rx="0.8" fill="var(--brand)" />
      <rect x="6" y="15.8" width="9" height="4.2" rx="1.4" fill="var(--surface)" />
    </svg>
  );
}

export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="brand">
      <Mark size={size} />
      <span>MANDATE</span>
    </span>
  );
}
