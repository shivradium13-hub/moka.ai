import type { ReactNode } from 'react';

/**
 * Minimal shared primitives.
 *
 * Deliberately small: Phase 1 needs a coherent shell, not a design system.
 * The full component library (@moka/ui, shadcn-based) lands with the richer
 * surfaces in Phase 2+, rather than being speculatively built now.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-[--color-line] bg-white shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="border-b border-[--color-line] px-5 py-4">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {description ? <p className="mt-0.5 text-xs text-[--color-muted]">{description}</p> : null}
    </div>
  );
}

export function Button({
  children,
  type = 'button',
  variant = 'primary',
  disabled,
  onClick,
}: {
  children: ReactNode;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  onClick?: () => void;
}) {
  const styles: Record<string, string> = {
    primary: 'bg-[--color-accent] text-white hover:opacity-90',
    secondary: 'border border-[--color-line] bg-white hover:bg-gray-50',
    danger: 'border border-[--color-danger] text-[--color-danger] hover:bg-red-50',
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center rounded-lg px-3.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  name,
  type = 'text',
  required,
  defaultValue,
  placeholder,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[--color-muted]">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'current-password' : undefined}
        className="h-9 w-full rounded-lg border border-[--color-line] bg-white px-3 text-sm outline-none focus:border-[--color-accent]"
      />
      {hint ? <span className="mt-1 block text-xs text-[--color-muted]">{hint}</span> : null}
    </label>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-[--color-danger]">
      {message}
    </p>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-[--color-muted]">{description}</p>
    </div>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-[--color-accent-soft] px-2 py-0.5 text-[11px] font-medium text-[--color-accent]">
      {children}
    </span>
  );
}
