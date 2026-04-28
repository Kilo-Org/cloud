'use client';

import KiloCrabIcon from '@/components/KiloCrabIcon';
import { cn } from '@/lib/utils';
import { ArrowRight, Briefcase, Check, Cloud, Download } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import './ProductOptionsContent.css';

type WelcomeContentProps = {
  isAuthenticated: boolean;
};

type RowCard = {
  key: string;
  title: string;
  description: string;
  icon: ReactNode;
  ctaLabel: string;
  ctaHref: string;
  variant: 'primary' | 'outline';
  iconTone?: 'brand' | 'muted';
  badge?: string;
};

function getAuthenticatedHref(isAuthenticated: boolean, path: string) {
  return isAuthenticated ? path : `/users/sign_in?callbackPath=${path}`;
}

function CardRow({ card, entranceDelayMs }: { card: RowCard; entranceDelayMs: number }) {
  const isPrimary = card.variant === 'primary';
  const iconTone = card.iconTone ?? 'brand';

  // The "New" badge sheen first fires shortly after the card itself has
  // entered, so the initial sweep feels like the last beat of the
  // choreographed arrival. It then loops every ~5.5s.
  const badgeSheenDelayMs = entranceDelayMs + 360;

  return (
    <Link
      href={card.ctaHref}
      style={{ animationDelay: `${entranceDelayMs}ms` }}
      className={cn(
        'group/row flex items-center gap-4 rounded-2xl p-4 ring-1 ring-inset outline-none ease-out-strong',
        'transition-[transform,background-color,box-shadow] duration-200',
        'kilo-fade-up',
        'motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.985]',
        'focus-visible:ring-2 focus-visible:ring-brand-primary/60',
        isPrimary
          ? 'ring-brand-primary/40 bg-brand-primary/[0.04] hover:ring-brand-primary/70 hover:bg-brand-primary/[0.07] shadow-[0_0_40px_-12px] shadow-brand-primary/20 hover:shadow-brand-primary/40'
          : 'ring-border bg-card/60 hover:ring-brand-primary/60 hover:bg-card/80'
      )}
    >
      <div
        className={cn(
          'ease-out-strong flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ring-1 transition-transform duration-200',
          'motion-safe:group-hover/row:scale-105',
          iconTone === 'brand'
            ? 'bg-brand-primary/10 text-brand-primary ring-brand-primary/20'
            : 'bg-muted/60 text-muted-foreground ring-border'
        )}
      >
        {card.icon}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-base font-bold text-white">{card.title}</h3>
          {card.badge ? (
            <span
              style={{ '--kilo-sheen-delay': `${badgeSheenDelayMs}ms` } as React.CSSProperties}
              className="bg-brand-primary/15 text-brand-primary ring-brand-primary/30 kilo-sheen kilo-sheen-play rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold tracking-[0.1em] uppercase ring-1"
            >
              {card.badge}
            </span>
          ) : null}
        </div>
        <p className="text-muted-foreground mt-0.5 text-sm">{card.description}</p>
      </div>

      <span
        className={cn(
          'ease-out-strong flex shrink-0 items-center gap-1.5 rounded-xl text-sm font-bold transition-colors duration-150',
          isPrimary
            ? 'bg-brand-primary text-black group-hover/row:bg-brand-primary/90 px-5 py-2.5'
            : 'border-border text-white group-hover/row:border-brand-primary/60 border px-4 py-2'
        )}
      >
        {card.ctaLabel}
        <ArrowRight className="ease-out-strong h-3.5 w-3.5 transition-transform duration-150 motion-safe:group-hover/row:translate-x-1" />
      </span>
    </Link>
  );
}

export default function WelcomeContent({ isAuthenticated }: WelcomeContentProps) {
  const cloudHref = getAuthenticatedHref(isAuthenticated, '/cloud');
  const kiloclawHref = getAuthenticatedHref(isAuthenticated, '/claw');
  const teamHref = getAuthenticatedHref(isAuthenticated, '/organizations/new');
  const signInHref = `/users/sign_in?callbackPath=/get-started`;

  const cards: RowCard[] = [
    {
      key: 'install',
      title: 'Install Kilo',
      description: 'Code with AI in VS Code, JetBrains, or CLI.',
      icon: <Download className="h-5 w-5" />,
      ctaLabel: 'Install',
      ctaHref: '/welcome',
      variant: 'primary',
    },
    {
      key: 'cloud',
      title: 'Kilo Cloud',
      description: 'Run agents against your repo from any browser.',
      icon: <Cloud className="h-5 w-5" />,
      ctaLabel: 'Connect repo',
      ctaHref: cloudHref,
      variant: 'outline',
    },
    {
      key: 'kiloclaw',
      title: 'KiloClaw',
      description: 'An always-on agent for Telegram, Slack, and more.',
      icon: <KiloCrabIcon className="h-6 w-6" />,
      ctaLabel: 'Get started',
      ctaHref: kiloclawHref,
      variant: 'outline',
      badge: 'New',
    },
  ];

  const bullets = [
    { lead: '500+ models.', detail: 'OpenRouter, Anthropic, OpenAI, or local models.' },
    { lead: 'Everywhere you code.', detail: 'VS Code, JetBrains, Cursor, CLI, or cloud.' },
    { lead: 'Sessions follow you.', detail: 'Start in your IDE, finish on your phone.' },
    { lead: 'Open source.', detail: 'Apache 2.0. Inspect, fork, and contribute.' },
  ];

  return (
    <div className="grid gap-10 lg:grid-cols-[5fr_6fr] lg:items-start lg:gap-12">
      <section className="space-y-6 lg:sticky lg:top-8">
        <Link
          href="/"
          className="ease-out-strong kilo-fade-up inline-flex items-center gap-3 rounded-md outline-none transition-transform duration-150 motion-safe:active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-primary/60"
        >
          <span className="bg-brand-primary flex h-10 w-10 items-center justify-center rounded-md text-black">
            <svg viewBox="0 0 32 32" className="h-8 w-8" fill="currentColor" aria-hidden="true">
              <path d="M23,26v-2h3v-5l-2-2h-4v2h-3v5l2,2h4ZM20,20h3v3h-3v-3Z" />
              <rect x="12" y="17" width="3" height="3" />
              <polygon points="26 12 23 12 23 9 20 6 17 6 17 9 20 9 20 12 17 12 17 15 26 15 26 12" />
              <path d="M0,0v32h32V0H0ZM29,29H3V3h26v26Z" />
              <polygon points="15 26 15 23 9 23 9 17 6 17 6 23.1875 8.8125 26 15 26" />
              <rect x="12" y="6" width="3" height="3" />
              <polygon points="9 12 12 12 12 15 15 15 15 12 12 9 9 9 9 6 6 6 6 15 9 15 9 12" />
            </svg>
          </span>
          <span className="text-2xl font-bold text-white">Kilo Code</span>
        </Link>
        <h1
          style={{ animationDelay: '60ms' }}
          className="kilo-fade-up text-4xl leading-[1.05] font-black tracking-tight text-balance md:text-5xl md:tracking-[-0.03em]"
        >
          <span className="block text-white md:whitespace-nowrap">One AI Coding Agent</span>
          <span className="block text-white">Every model</span>
          <span className="text-brand-primary block">No subscription</span>
        </h1>
        <p
          style={{ animationDelay: '140ms' }}
          className="text-muted-foreground kilo-fade-up max-w-xl text-lg leading-[1.55] text-balance"
        >
          Use Kilo in your editor, terminal, or cloud. Bring your own API key, use free models, or
          pay as you go.
        </p>

        <ul className="space-y-2 pt-2">
          {bullets.map((item, i) => (
            <li
              key={item.lead}
              style={{ animationDelay: `${220 + i * 55}ms` }}
              className="kilo-fade-up flex items-start gap-3 text-[0.9375rem] leading-[1.55]"
            >
              <Check className="text-brand-primary mt-1 h-4 w-4 shrink-0" strokeWidth={2.5} />
              <span>
                <span className="font-semibold tracking-tight text-white">{item.lead}</span>{' '}
                <span className="text-muted-foreground">{item.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="get-started-pick" className="space-y-3 lg:mt-2">
        <h2
          id="get-started-pick"
          className="text-muted-foreground kilo-fade-up text-[0.6875rem] font-semibold tracking-[0.18em] uppercase"
        >
          Pick a starting point
        </h2>

        <div className="space-y-2.5">
          {cards.map((card, i) => (
            <CardRow key={card.key} card={card} entranceDelayMs={80 + i * 90} />
          ))}
        </div>

        <div className="border-border/50 mt-8 border-t pt-6">
          <CardRow
            entranceDelayMs={440}
            card={{
              key: 'team',
              title: 'Using Kilo for work?',
              description: 'Shared credits, access controls, and team billing.',
              icon: <Briefcase className="h-5 w-5" />,
              ctaLabel: 'Create team',
              ctaHref: teamHref,
              variant: 'outline',
              iconTone: 'muted',
            }}
          />
        </div>

        {!isAuthenticated ? (
          <p
            style={{ animationDelay: '540ms' }}
            className="text-muted-foreground kilo-fade-up pt-1 text-center text-xs"
          >
            Already have an account?{' '}
            <Link
              href={signInHref}
              className="text-brand-primary rounded font-semibold outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary/60"
            >
              Sign in
            </Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
