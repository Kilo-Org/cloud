'use client';

import type { ReactNode } from 'react';

export type PrototypeTocItem = {
  id: string;
  label: string;
};

export function PrototypePageShell({
  eyebrow,
  title,
  description,
  sidebar,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12 px-4 py-10 md:px-8 md:py-12">
        <header className="space-y-3 border-b pb-8">
          <p className="text-muted-foreground text-xs uppercase tracking-[0.18em]">{eyebrow}</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{title}</h1>
          <div className="text-muted-foreground max-w-2xl text-sm">{description}</div>
        </header>

        <div className="grid gap-12 lg:grid-cols-[260px_1fr]">
          <aside className="lg:sticky lg:top-8 lg:h-fit lg:self-start">{sidebar}</aside>
          <main className="min-w-0 space-y-20">{children}</main>
        </div>

        {footer && <footer className="border-t pt-8">{footer}</footer>}
      </div>
    </div>
  );
}

export function PrototypeSection({
  id,
  title,
  description,
  url,
  visibilityLabel,
  visible = true,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  url: string;
  visibilityLabel?: string;
  visible?: boolean;
  children: ReactNode;
}) {
  if (!visible) return null;

  return (
    <section id={id} className="scroll-mt-24 space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
          {visibilityLabel && (
            <span className="text-muted-foreground border-border rounded-md border px-2 py-0.5 text-[11px] uppercase tracking-wide">
              {visibilityLabel}
            </span>
          )}
        </div>
        <p className="text-muted-foreground font-mono text-xs">URL: {url}</p>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </header>
      <div className="space-y-12">{children}</div>
    </section>
  );
}

export function PrototypeVariant({
  label,
  caption,
  visible = true,
  children,
}: {
  label: string;
  caption?: string;
  visible?: boolean;
  children: ReactNode;
}) {
  if (!visible) return null;

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-semibold">{label}</p>
        {caption && <p className="text-muted-foreground text-xs">{caption}</p>}
      </div>
      <div className="bg-background/40 rounded-2xl border-2 border-dashed border-border p-4 md:p-6">
        {children}
      </div>
    </div>
  );
}

export function PrototypeTableOfContents({ items }: { items: PrototypeTocItem[] }) {
  function handleJump(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    const target = document.getElementById(id);
    if (!target) return;

    const offset = 24;
    const scroller = findScrollableAncestor(target);
    const targetTop = getScrollTargetTop(target, scroller, offset);

    smoothScrollTo(scroller, targetTop);
    window.history.replaceState(null, '', `#${id}`);
  }

  return (
    <ul className="space-y-1.5 text-sm">
      {items.map(item => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            onClick={event => handleJump(event, item.id)}
            className="text-muted-foreground hover:text-foreground hover:bg-muted block rounded-md px-2 py-1"
          >
            {item.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function findScrollableAncestor(node: HTMLElement): HTMLElement | Window {
  let current: HTMLElement | null = node.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    const isScrollable =
      (overflowY === 'auto' || overflowY === 'scroll') &&
      current.scrollHeight > current.clientHeight;
    if (isScrollable) return current;
    current = current.parentElement;
  }
  return window;
}

function getScrollTargetTop(target: HTMLElement, scroller: HTMLElement | Window, offset: number) {
  if (isWindowScroller(scroller))
    return target.getBoundingClientRect().top + window.scrollY - offset;

  return (
    target.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop -
    offset
  );
}

function isWindowScroller(scroller: HTMLElement | Window): scroller is Window {
  return scroller === window;
}

function smoothScrollTo(scroller: HTMLElement | Window, top: number) {
  const start = isWindowScroller(scroller) ? window.scrollY : scroller.scrollTop;
  const distance = top - start;
  if (Math.abs(distance) < 1) return;
  const duration = Math.min(600, Math.max(220, Math.abs(distance) * 0.5));
  const startTime = performance.now();

  function step(now: number) {
    const t = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const next = start + distance * eased;
    if (isWindowScroller(scroller)) {
      window.scrollTo(0, next);
    } else {
      scroller.scrollTop = next;
    }
    if (t < 1) requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
}
