/** Small schematic diagrams for the "how it works" steps. Drawn with the design tokens. */

const box = { fill: "var(--surface-2)", stroke: "var(--line-2)", strokeWidth: 1 } as const;

export function EscrowArt() {
  return (
    <svg viewBox="0 0 240 92" aria-hidden="true">
      <rect x="18" y="30" width="44" height="12" rx="3" fill="var(--ask)" opacity="0.85" />
      <rect x="18" y="48" width="44" height="12" rx="3" fill="var(--bid)" opacity="0.85" />
      <path d="M72 46 H112" stroke="var(--faint)" strokeWidth="1.5" strokeDasharray="3 3" markerEnd="url(#arr)" />
      <rect x="120" y="18" width="100" height="56" rx="8" {...box} />
      <rect x="130" y="30" width="36" height="10" rx="2.5" fill="var(--ask)" opacity="0.85" />
      <rect x="130" y="46" width="36" height="10" rx="2.5" fill="var(--bid)" opacity="0.85" />
      <rect x="130" y="60" width="22" height="6" rx="2" fill="var(--faint)" opacity="0.6" />
      <circle cx="197" cy="46" r="11" fill="var(--brand-soft)" />
      <rect x="192" y="45" width="10" height="8" rx="1.5" fill="var(--brand)" />
      <path d="M194 45 v-3 a3 3 0 0 1 6 0 v3" fill="none" stroke="var(--brand)" strokeWidth="1.6" />
      <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--faint)" /></marker></defs>
    </svg>
  );
}

export function CommitArt() {
  return (
    <svg viewBox="0 0 240 92" aria-hidden="true">
      {[10, 16, 24, 30, 34].map((h, i) => <rect key={`b${i}`} x={30 + i * 12} y={46 - h} width="8" height={h} rx="2" fill="var(--bid)" opacity="0.85" />)}
      {[34, 28, 22, 16, 10].map((h, i) => <rect key={`c${i}`} x={98 + i * 12} y={46 - h} width="8" height={h} rx="2" fill="var(--ask)" opacity="0.85" />)}
      <line x1="95" x2="95" y1="8" y2="54" stroke="var(--brand)" strokeWidth="1.6" strokeDasharray="4 3" />
      <line x1="24" x2="166" y1="46" y2="46" stroke="var(--line-2)" />
      <text x="54" y="72" fontSize="13" textAnchor="middle" fill="var(--muted)" fontFamily="var(--font)">bids</text>
      <text x="126" y="72" fontSize="13" textAnchor="middle" fill="var(--muted)" fontFamily="var(--font)">asks</text>
      <rect x="178" y="22" width="46" height="46" rx="10" {...box} />
      <path d="M201 32 l9 4 v8 c0 6 -4 9 -9 11 c-5 -2 -9 -5 -9 -11 v-8 z" fill="var(--brand-soft)" stroke="var(--brand)" strokeWidth="1.4" />
      <text x="201" y="84" fontSize="13" textAnchor="middle" fill="var(--muted)" fontFamily="var(--font)">bond</text>
    </svg>
  );
}

export function VerifyArt() {
  const cells = [1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 2, 1, 1, 1];
  return (
    <svg viewBox="0 0 240 92" aria-hidden="true">
      {cells.map((c, i) => (
        <rect key={i} x={20 + i * 14} y="28" width="10" height="36" rx="2.5" fill={c === 1 ? "var(--pass)" : c === 2 ? "var(--fail)" : "var(--idle)"} />
      ))}
      <circle cx="172" cy="40" r="17" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2.2" />
      <path d="M184 52 L198 66" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
      <path d="M164 40 l6 6 l10 -11" fill="none" stroke="var(--pass)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SettleArt() {
  return (
    <svg viewBox="0 0 240 92" aria-hidden="true">
      <rect x="16" y="26" width="64" height="40" rx="8" {...box} />
      <text x="48" y="51" fontSize="13" textAnchor="middle" fill="var(--ink-2)" fontFamily="var(--font)" fontWeight="600">period</text>
      <path d="M84 40 C 110 40, 110 22, 138 22" fill="none" stroke="var(--pass)" strokeWidth="1.8" />
      <path d="M84 52 C 110 52, 110 70, 138 70" fill="none" stroke="var(--fail)" strokeWidth="1.8" strokeDasharray="3 3" />
      <rect x="142" y="10" width="82" height="24" rx="6" fill="var(--pass-soft)" />
      <text x="183" y="26" fontSize="12" textAnchor="middle" fill="var(--pass)" fontFamily="var(--font)" fontWeight="600">maker paid</text>
      <rect x="142" y="58" width="82" height="24" rx="6" fill="var(--fail-soft)" />
      <text x="183" y="74" fontSize="12" textAnchor="middle" fill="var(--fail)" fontFamily="var(--font)" fontWeight="600">bond slashed</text>
    </svg>
  );
}
