'use client';

import { CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ArrowRight, Cloud, ExternalLink, Monitor, Terminal, WandSparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import Image from 'next/image';
import Link from 'next/link';

type WelcomeContentProps = {
  isAuthenticated: boolean;
};

type ProductOption = {
  title: string;
  eyebrow: string;
  description: string;
  href: string;
  cta: string;
  Icon: LucideIcon;
  accentClassName: string;
  preview: 'editor' | 'cli' | 'cloud' | 'app-builder';
};

function getAuthenticatedHref(isAuthenticated: boolean, path: string) {
  return isAuthenticated ? path : `/users/sign_in?callbackPath=${path}`;
}

const optionActionClassName =
  'border-border bg-background/40 hover:border-brand-primary/60 flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-bold text-white transition-colors';

function OptionPreview({ option }: { option: ProductOption }) {
  if (option.preview === 'editor') {
    return (
      <div className="bg-background/50 ring-border relative h-28 overflow-hidden rounded-xl ring-1">
        <div className="border-border flex h-7 items-center gap-1.5 border-b px-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
          <span className="bg-muted ml-2 h-2 w-16 rounded-full" />
        </div>
        <div className="grid h-[calc(100%-1.75rem)] grid-cols-[0.8fr_1fr]">
          <div className="border-border/80 space-y-2 border-r p-3">
            <span className="bg-brand-primary/50 block h-2 w-16 rounded-full" />
            <span className="bg-muted block h-2 w-12 rounded-full" />
            <span className="bg-muted block h-2 w-20 rounded-full" />
          </div>
          <div className="space-y-2 p-3 font-mono text-[10px] leading-none text-white/70">
            <motion.div
              initial={{ width: '28%' }}
              animate={{ width: ['28%', '82%', '52%'] }}
              transition={{ duration: 3.2, repeat: Infinity, repeatType: 'reverse' }}
              className="bg-brand-primary/70 h-2 rounded-full"
            />
            <div className="bg-white/20 h-2 w-3/4 rounded-full" />
            <div className="bg-white/10 h-2 w-1/2 rounded-full" />
            <motion.div
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.2, repeat: Infinity }}
              className="mt-3 h-3 w-1 rounded-sm bg-white"
            />
          </div>
        </div>
      </div>
    );
  }

  if (option.preview === 'cli') {
    return (
      <div className="bg-background/60 ring-border h-28 overflow-hidden rounded-xl p-3 font-mono text-[11px] ring-1">
        <div className="mb-2 flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-300/80" />
          <span className="text-muted-foreground text-[10px]">~/repo</span>
        </div>
        <p className="text-white/75">
          <span className="text-sky-300">$</span> kilo plan auth-flow
        </p>
        <motion.div
          initial={{ x: '-100%' }}
          animate={{ x: ['-100%', '0%', '100%'] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          className="my-3 h-px w-full bg-gradient-to-r from-transparent via-sky-300 to-transparent"
        />
        <p className="text-emerald-300/90">ok reading files</p>
        <p className="text-emerald-300/70">ok drafting changes</p>
        <motion.p
          animate={{ opacity: [0.35, 1, 0.35] }}
          transition={{ duration: 1.1, repeat: Infinity }}
          className="text-white/70"
        >
          _
        </motion.p>
      </div>
    );
  }

  if (option.preview === 'cloud') {
    return (
      <div className="bg-background/55 ring-border relative h-28 overflow-hidden rounded-xl ring-1">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(125,211,252,0.18),transparent_34%),radial-gradient(circle_at_80%_60%,rgba(56,189,248,0.12),transparent_32%)]" />
        <motion.div
          animate={{ x: [0, 10, 0], y: [0, -5, 0] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-4 left-4 rounded-lg border border-blue-300/30 bg-blue-300/10 px-2 py-1 text-[10px] font-bold text-blue-100"
        >
          issue #248
        </motion.div>
        <motion.div
          animate={{ x: [0, -8, 0], y: [0, 4, 0] }}
          transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-10 right-4 rounded-lg border border-white/15 bg-white/8 px-2 py-1 text-[10px] text-white/75"
        >
          branch/kilo-fix
        </motion.div>
        <div className="absolute top-1/2 right-8 left-8 h-px bg-gradient-to-r from-transparent via-blue-300/70 to-transparent" />
        <motion.div
          animate={{ left: ['20%', '72%', '20%'] }}
          transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-[calc(50%-4px)] h-2 w-2 rounded-full bg-blue-200 shadow-[0_0_18px_rgba(125,211,252,0.8)]"
        />
        <div className="absolute bottom-8 left-4 rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-2 py-1 text-[10px] font-bold text-emerald-200">
          PR ready
        </div>
      </div>
    );
  }

  if (option.preview === 'app-builder') {
    return (
      <div className="bg-background/55 ring-border relative h-28 overflow-hidden rounded-xl ring-1">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(217,70,239,0.22),transparent_30%),radial-gradient(circle_at_80%_80%,rgba(250,204,21,0.14),transparent_35%)]" />
        <motion.div
          animate={{ scale: [1, 1.04, 1], rotate: [0, -1, 0] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute inset-x-8 top-4 bottom-6 rounded-xl border border-white/15 bg-white/[0.07] p-2 shadow-2xl"
        >
          <div className="mb-2 h-3 w-14 rounded-full bg-fuchsia-200/60" />
          <div className="grid grid-cols-[0.75fr_1fr] gap-2">
            <div className="space-y-1.5">
              <span className="block h-2 rounded-full bg-white/30" />
              <span className="block h-2 w-4/5 rounded-full bg-white/20" />
              <span className="block h-5 w-14 rounded-md bg-fuchsia-300/40" />
            </div>
            <motion.div
              animate={{ y: [0, -3, 0] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
              className="rounded-lg bg-gradient-to-br from-fuchsia-300/70 via-yellow-200/60 to-sky-300/60"
            />
          </div>
        </motion.div>
      </div>
    );
  }

  return null;
}

export default function WelcomeContent({ isAuthenticated }: WelcomeContentProps) {
  const cloudHref = getAuthenticatedHref(isAuthenticated, '/cloud');
  const appBuilderHref = getAuthenticatedHref(isAuthenticated, '/app-builder');
  const profileHref = isAuthenticated ? '/profile' : '/users/sign_in?callbackPath=/profile';

  const localOptions = [
    { label: 'VS Code', href: '/welcome', iconSrc: '/logos/vscode.svg', alt: 'VS Code' },
    {
      label: 'JetBrains',
      href: '/welcome?source=idea',
      iconSrc: '/logos/idea.svg',
      alt: 'JetBrains',
    },
  ];

  const productOptions: ProductOption[] = [
    {
      title: 'CLI',
      eyebrow: 'Terminal',
      description: 'Code, plan, and debug from any repo in your shell.',
      href: '/welcome?target=cli',
      cta: 'Install the CLI',
      Icon: Terminal,
      accentClassName: 'bg-sky-500/10 text-sky-300 ring-sky-400/30',
      preview: 'cli',
    },
    {
      title: 'Cloud',
      eyebrow: 'Hosted agents',
      description: 'Start work from anywhere. Finish where you code.',
      href: cloudHref,
      cta: 'Start Cloud Agent',
      Icon: Cloud,
      accentClassName: 'bg-blue-500/10 text-blue-300 ring-blue-400/30',
      preview: 'cloud',
    },
    {
      title: 'Prototype',
      eyebrow: 'App builder',
      description: 'Go from idea to prototype in minutes, then keep the code.',
      href: appBuilderHref,
      cta: 'Open App Builder',
      Icon: WandSparkles,
      accentClassName: 'bg-fuchsia-500/10 text-fuchsia-300 ring-fuchsia-400/30',
      preview: 'app-builder',
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3 }}
    >
      <CardContent className="space-y-4 p-0">
        <section className="grid items-end gap-3 md:grid-cols-[1fr_auto]">
          <div className="max-w-3xl space-y-2">
            <p className="text-brand-primary text-xs font-black tracking-[0.22em] uppercase">
              Open source AI coding
            </p>
            <h1 className="text-4xl leading-none font-black tracking-tight text-balance md:text-5xl">
              Code with 500+ models, your keys or ours. Open source.
            </h1>
            <p className="text-muted-foreground max-w-2xl text-base leading-6 text-balance">
              Choose your workflow: IDE, terminal, cloud, or prototype.
            </p>
          </div>
          <a
            href="https://kilo.ai/coding"
            className="text-brand-primary inline-flex items-center gap-1.5 text-sm font-bold whitespace-nowrap hover:underline"
          >
            Learn more
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <motion.div
            whileHover={{ scale: 1.005, y: -2 }}
            whileTap={{ scale: 0.995 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          >
            <div className="group/card ring-border bg-card/80 hover:ring-brand-primary/70 hover:shadow-brand-primary/10 flex h-full flex-col gap-4 rounded-2xl p-4 ring-1 transition-all duration-300 ring-inset hover:shadow-xl">
              <OptionPreview
                option={{
                  title: 'IDE',
                  eyebrow: 'Extension',
                  description: 'Add Kilo to VS Code or JetBrains.',
                  href: '/welcome',
                  cta: 'See editor installs',
                  Icon: Monitor,
                  accentClassName: 'bg-brand-primary/10 text-brand-primary ring-brand-primary/30',
                  preview: 'editor',
                }}
              />

              <div className="flex items-start gap-3">
                <div className="bg-brand-primary/10 text-brand-primary ring-brand-primary/30 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ring-1">
                  <Monitor className="h-5 w-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-brand-primary/80 text-[0.7rem] font-semibold tracking-[0.18em] uppercase">
                    Extension
                  </p>
                  <h2 className="text-xl font-black tracking-tight text-white">IDE</h2>
                  <p className="text-muted-foreground text-sm leading-5">
                    Add Kilo to VS Code or JetBrains.
                  </p>
                </div>
              </div>

              <div className="mt-auto grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                {localOptions.map(option => (
                  <Link key={option.label} href={option.href} className={optionActionClassName}>
                    {option.iconSrc ? (
                      <Image src={option.iconSrc} alt={option.alt} width={18} height={18} />
                    ) : (
                      <Terminal className="h-4 w-4 text-sky-300" />
                    )}
                    {option.label}
                  </Link>
                ))}
              </div>
            </div>
          </motion.div>

          {productOptions.map(option => (
            <motion.div
              key={option.title}
              whileHover={{ scale: 1.01, y: -2 }}
              whileTap={{ scale: 0.99 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            >
              <div className="group/card ring-border bg-card/80 hover:ring-brand-primary/70 hover:shadow-brand-primary/10 flex h-full flex-col rounded-2xl ring-1 transition-all duration-300 ring-inset hover:shadow-xl">
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <OptionPreview option={option} />

                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ring-1 transition-all duration-300 group-hover/card:scale-105',
                        option.accentClassName
                      )}
                    >
                      <option.Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <p className="text-brand-primary/80 text-[0.7rem] font-semibold tracking-[0.18em] uppercase">
                        {option.eyebrow}
                      </p>
                      <h2 className="text-xl font-black tracking-tight text-white">
                        {option.title}
                      </h2>
                      <p className="text-muted-foreground text-sm leading-5">
                        {option.description}
                      </p>
                    </div>
                  </div>

                  <Link
                    href={option.href}
                    className={cn(optionActionClassName, 'mt-auto text-brand-primary')}
                  >
                    {option.cta}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            </motion.div>
          ))}
        </section>

        <div className="text-center">
          <p className="text-muted-foreground text-sm">
            {isAuthenticated ? (
              <>
                Or jump to{' '}
                <Link href="/profile" className="text-brand-primary underline">
                  your profile
                </Link>
                , where you&apos;ll find all these options.
              </>
            ) : (
              <>
                Or{' '}
                <Link href={profileHref} className="text-brand-primary underline">
                  sign in or sign up
                </Link>{' '}
                to access your profile and all these options.
              </>
            )}
          </p>
        </div>
      </CardContent>
    </motion.div>
  );
}
