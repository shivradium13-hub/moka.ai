import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowIcon } from './icons';

/**
 * Layout and typography primitives for the public site.
 *
 * Separate from `components/ui.tsx` on purpose: that file is the application
 * shell's vocabulary (dense, 9px-gutter, data-first) and this one is the
 * marketing page's (airy, large type, dark bands). Sharing one Button between
 * two surfaces with opposite goals produces a component with a `marketing`
 * flag on every prop, which is worse than two small honest components.
 */

/** Constrains content to the site's measure and adds the responsive gutter. */
export function Container({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

export function Section({
  children,
  className = '',
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`py-20 sm:py-28 ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

/** Small capitalised label above a heading. `tone` follows the band it sits in. */
export function Eyebrow({
  children,
  tone = 'light',
}: {
  children: ReactNode;
  tone?: 'light' | 'dark';
}) {
  return (
    <p
      className={`text-xs font-semibold tracking-[0.14em] uppercase ${
        tone === 'dark' ? 'text-violet' : 'text-accent'
      }`}
    >
      {children}
    </p>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  tone = 'light',
  align = 'left',
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: 'light' | 'dark';
  align?: 'left' | 'center';
}) {
  return (
    <div className={`max-w-2xl ${align === 'center' ? 'mx-auto text-center' : ''}`}>
      {eyebrow ? <Eyebrow tone={tone}>{eyebrow}</Eyebrow> : null}
      <h2
        className={`mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl ${
          tone === 'dark' ? 'text-white' : 'text-ink'
        }`}
      >
        {title}
      </h2>
      {description ? (
        <p
          className={`mt-4 text-base leading-relaxed text-pretty sm:text-lg ${
            tone === 'dark' ? 'text-night-muted' : 'text-muted'
          }`}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

type CtaProps = { href: string; children: ReactNode; className?: string };

export function PrimaryCta({ href, children, className = '' }: CtaProps) {
  return (
    <Link
      href={href}
      className={`group inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ink px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent ${className}`}
    >
      {children}
      <ArrowIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export function SecondaryCta({ href, children, className = '' }: CtaProps) {
  return (
    <Link
      href={href}
      className={`inline-flex h-11 items-center justify-center rounded-xl border border-line bg-white px-5 text-sm font-semibold text-ink transition hover:border-ink/25 hover:bg-chalk ${className}`}
    >
      {children}
    </Link>
  );
}

/** The same two calls to action, used at the top and bottom of every page. */
export function CtaPair({ className = '' }: { className?: string }) {
  return (
    <div className={`flex flex-col gap-3 sm:flex-row ${className}`}>
      <PrimaryCta href="/signup">Start free</PrimaryCta>
      <SecondaryCta href="/product">See how it works</SecondaryCta>
    </div>
  );
}

export function FeatureCard({
  icon,
  title,
  children,
  href,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
        {icon}
      </span>
      <h3 className="mt-5 text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
      {href ? (
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-accent">
          Learn more
          <ArrowIcon className="h-4 w-4" />
        </span>
      ) : null}
    </>
  );

  const shell = 'flex h-full flex-col rounded-2xl border border-line bg-white p-6 transition';

  return href ? (
    <Link href={href} className={`${shell} hover:-translate-y-0.5 hover:shadow-md`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

/** A claim paired with the mechanism behind it, for the dark bands. */
export function DarkPoint({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-night-line bg-night-soft p-6">
      <h3 className="text-sm font-semibold tracking-tight text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-night-muted">{children}</p>
    </div>
  );
}

/** Renders a page's top matter; every marketing page except the home page uses it. */
export function PageHero({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="relative overflow-hidden border-b border-line bg-white">
      <div className="grid-backdrop absolute inset-0" aria-hidden="true" />
      <Container className="relative py-20 sm:py-24">
        <div className="max-w-3xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            {title}
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-pretty text-muted">{description}</p>
        </div>
      </Container>
    </header>
  );
}
