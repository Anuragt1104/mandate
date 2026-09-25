/**
 * The Mandate mark: four scored periods on an ink tile, the last one live. It is the
 * product drawn small: liquidity measured period after period.
 */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block", flex: "none" }}>
      <rect width="24" height="24" rx="6.5" fill="var(--ink)" />
      {[5.5, 9.5, 13.5].map((x) => <rect key={x} x={x} y="6" width="2.6" height="12" rx="1.1" fill="var(--surface)" />)}
      <rect x="17.5" y="6" width="2.6" height="12" rx="1.1" fill="var(--up)" />
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
