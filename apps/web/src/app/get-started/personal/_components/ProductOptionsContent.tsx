'use client';

import KiloCrabIcon from '@/components/KiloCrabIcon';
import { CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ArrowRight, Check, Cloud, Download, Users } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

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

function CardRow({ card }: { card: RowCard }) {
  const isPrimary = card.variant === 'primary';
  const iconTone = card.iconTone ?? 'brand';

  return (
    <motion.div whileHover={{ y: -2 }} transition={{ type: 'spring', stiffness: 300, damping: 25 }}>
      <Link
        href={card.ctaHref}
        className={cn(
          'group/row flex items-center gap-4 rounded-2xl p-4 ring-1 transition-all duration-300 ring-inset',
          isPrimary
            ? 'ring-brand-primary/40 bg-brand-primary/[0.04] hover:ring-brand-primary/70 hover:bg-brand-primary/[0.07] shadow-[0_0_40px_-12px] shadow-brand-primary/20'
            : 'ring-border bg-card/60 hover:ring-brand-primary/60 hover:bg-card/80'
        )}
      >
        <div
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ring-1 transition-transform duration-300 group-hover/row:scale-105',
            iconTone === 'brand'
              ? 'bg-brand-primary/10 text-brand-primary ring-brand-primary/20'
              : 'bg-muted/60 text-muted-foreground ring-border'
          )}
        >
          {card.icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-bold text-white">{card.title}</h2>
            {card.badge ? (
              <span className="bg-brand-primary/15 text-brand-primary ring-brand-primary/30 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold tracking-[0.1em] uppercase ring-1">
                {card.badge}
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-sm">{card.description}</p>
        </div>

        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-xl text-sm font-bold transition-colors',
            isPrimary
              ? 'bg-brand-primary text-black group-hover/row:bg-brand-primary/90 px-5 py-2.5'
              : 'border-border text-white group-hover/row:border-brand-primary/60 border px-4 py-2'
          )}
        >
          {card.ctaLabel}
          <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover/row:translate-x-0.5" />
        </span>
      </Link>
    </motion.div>
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
      description: 'VS Code, JetBrains, Cursor, or CLI',
      icon: <Download className="h-5 w-5" />,
      ctaLabel: 'Install',
      ctaHref: '/welcome',
      variant: 'primary',
    },
    {
      key: 'cloud',
      title: 'Cloud sessions',
      description: 'Run agents against your repo — no local machine',
      icon: <Cloud className="h-5 w-5" />,
      ctaLabel: 'Connect repo',
      ctaHref: cloudHref,
      variant: 'outline',
    },
    {
      key: 'kiloclaw',
      title: 'KiloClaw',
      description: 'Your own AI coding agent, hosted in the cloud',
      icon: <KiloCrabIcon className="h-6 w-6" />,
      ctaLabel: 'Try',
      ctaHref: kiloclawHref,
      variant: 'outline',
      badge: 'New',
    },
  ];

  return (
    <CardContent className="p-0">
      <div className="grid gap-10 lg:grid-cols-[5fr_6fr] lg:items-start lg:gap-12">
        <section className="space-y-6 lg:sticky lg:top-8">
          <Link
            href="/"
            aria-label="Kilo home"
            className="inline-flex items-center gap-3 outline-none"
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
          <h1 className="text-4xl leading-[1.05] font-black tracking-tight text-balance md:text-5xl md:tracking-[-0.03em]">
            <span className="block whitespace-nowrap text-white">One AI Coding Agent</span>
            <span className="block text-white">Every model</span>
            <span className="text-brand-primary block">No subscription</span>
          </h1>
          <p className="text-muted-foreground max-w-xl text-lg leading-[1.55] text-balance">
            Use Kilo in your editor, terminal, or browser. Bring your own API key, use free models,
            or pay as you go.
          </p>

          <ul className="space-y-2 pt-2">
            {[
              {
                lead: '500+ models.',
                detail: 'OpenRouter, Anthropic, OpenAI, local, and more.',
              },
              {
                lead: 'Everywhere you code.',
                detail: 'VS Code, JetBrains, Cursor, CLI, or cloud.',
              },
              {
                lead: 'Sessions follow you.',
                detail: 'Start on mobile, finish in your IDE.',
              },
              {
                lead: 'Open source.',
                detail: 'Apache 2.0. Inspect, fork, and contribute.',
              },
            ].map(item => (
              <li
                key={item.lead}
                className="flex items-start gap-3 text-[0.9375rem] leading-[1.55]"
              >
                <Check className="text-muted-foreground mt-1 h-4 w-4 shrink-0" strokeWidth={2.5} />
                <span>
                  <span className="font-semibold tracking-tight text-white">{item.lead}</span>{' '}
                  <span className="text-muted-foreground">{item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.18em] uppercase">
            Pick a starting point
          </p>

          <div className="space-y-2.5">
            {cards.map(card => (
              <CardRow key={card.key} card={card} />
            ))}
          </div>

          <div className="border-border/50 mt-8 border-t pt-6">
            <CardRow
              card={{
                key: 'team',
                title: 'Using Kilo for work?',
                description: 'Shared credits, access controls, and team billing.',
                icon: <Users className="h-5 w-5" />,
                ctaLabel: 'Create team',
                ctaHref: teamHref,
                variant: 'outline',
                iconTone: 'muted',
              }}
            />
          </div>

          {!isAuthenticated ? (
            <p className="text-muted-foreground pt-1 text-center text-xs">
              Already have an account?{' '}
              <Link href={signInHref} className="text-brand-primary font-semibold hover:underline">
                Sign in
              </Link>
            </p>
          ) : null}
        </section>
      </div>
    </CardContent>
  );
}
