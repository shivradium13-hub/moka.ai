/**
 * Inline icon set.
 *
 * Hand-drawn on a 24x24 grid rather than pulled from an icon package: the
 * marketing site needs eleven glyphs, and a dependency that ships a thousand
 * is a bundle and a supply-chain surface bought for nothing.
 *
 * Every icon is `aria-hidden` — each one sits beside a real text label, so
 * announcing it again would only make a screen reader repeat itself.
 */

type IconProps = { className?: string };

function Glyph({ className = 'h-5 w-5', children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export function KnowledgeIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.8 1.8 0 0 0-1.8-1.5H5.5A1.5 1.5 0 0 1 4 16Z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.8 1.8 0 0 1 1.8-1.5h4.7A1.5 1.5 0 0 0 20 16Z" />
    </Glyph>
  );
}

export function AgentIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 4v3" />
      <circle cx="9" cy="13" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.15" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function ResearchIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.3-4.3" />
      <path d="M8.6 10.4h4.8M8.6 13h3" />
    </Glyph>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20 12.5a6.5 6.5 0 0 1-6.5 6.5H8l-4 3v-4.6A6.5 6.5 0 0 1 4 12.5v-1A6.5 6.5 0 0 1 10.5 5h3A6.5 6.5 0 0 1 20 11.5Z" />
      <path d="M9 12h6" />
    </Glyph>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.5 19 6v5.8c0 4.2-2.8 7.3-7 8.7-4.2-1.4-7-4.5-7-8.7V6Z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </Glyph>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="15" r="3.5" />
      <path d="m10.6 12.6 7-7M16.4 6.8l2 2M14 9.2l2 2" />
    </Glyph>
  );
}

export function RouteIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M8.2 6H14a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h5.8" />
    </Glyph>
  );
}

export function LedgerIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
      <path d="M8 8h8M8 12h8M8 16h4" />
    </Glyph>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
    </Glyph>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 12h13.5M13 6.5 18.5 12 13 17.5" />
    </Glyph>
  );
}

export function CheckIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="m4.5 10.5 3.5 3.5 7.5-8" />
    </svg>
  );
}

export function MinusIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M5.5 10h9" />
    </svg>
  );
}

export function Wordmark({ className = 'h-6 w-6' }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <linearGradient id="moka-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="100%" stopColor="#7c5cff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#moka-mark)" />
      <path
        d="M9 22V10.5l7 6.2 7-6.2V22"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
