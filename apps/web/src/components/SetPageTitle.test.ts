import React, { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { PageTitleProvider, usePageTitle } from '@/contexts/PageTitleContext';
import { SetPageTitle } from './SetPageTitle';
import type { AppTopbar as AppTopbarComponent } from '@/app/(app)/components/AppTopbar';

Object.assign(globalThis, { React });

jest.mock('@/components/ui/sidebar', () => ({
  SidebarTrigger: () => createElement('button', { 'aria-label': 'Toggle sidebar' }),
}));

let AppTopbar: typeof AppTopbarComponent;

function Actions() {
  const { setActions } = usePageTitle();
  useEffect(() => {
    setActions(createElement('button', null, 'Settings'));
    return () => setActions(null);
  }, [setActions]);
  return null;
}

function Surface({ subtitle, registered = true }: { subtitle?: ReactNode; registered?: boolean }) {
  return createElement(
    PageTitleProvider,
    null,
    createElement(AppTopbar),
    createElement(Actions),
    registered
      ? createElement(
          SetPageTitle,
          {
            title: 'Authentication fix',
            icon: createElement('span', { 'data-icon': true }, 'Icon'),
            subtitle,
          },
          createElement('button', null, 'Cost $0.42')
        )
      : null
  );
}

describe('page title subtitle', () => {
  let root: Root;
  let container: HTMLElement;
  let previous: { window: Window; document: Document; IS_REACT_ACT_ENVIRONMENT: unknown };

  beforeAll(async () => {
    ({ AppTopbar } = await import('@/app/(app)/components/AppTopbar'));
  });

  beforeEach(() => {
    const requireFromHere = createRequire(__filename);
    const { parseHTML } = requireFromHere(
      '../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
    ) as { parseHTML: (html: string) => { window: Window; document: Document } };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    previous = {
      window: globalThis.window,
      document: globalThis.document,
      IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
    };
    Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
    const element = document.getElementById('root');
    if (!element) throw new Error('Missing page title test root');
    container = element;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    Object.assign(globalThis, previous);
  });

  it('preserves the single-line header, icon, cost, and actions without a subtitle', () => {
    act(() => root.render(createElement(Surface)));

    expect(container.querySelector('header')?.className).toContain('h-14');
    expect(container.textContent).toContain('Authentication fix');
    expect(container.querySelector('[data-icon]')).not.toBeNull();
    expect(container.textContent).toContain('Cost $0.42');
    expect(container.textContent).toContain('Settings');
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders a subtitle beneath, not within, the title breadcrumb and preserves controls', () => {
    act(() =>
      root.render(
        createElement(Surface, {
          subtitle: createElement('a', { href: '/cloud/chat?sessionId=ses_parent' }, 'View parent'),
        })
      )
    );

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/cloud/chat?sessionId=ses_parent');
    expect(link?.closest('nav')).toBeNull();
    expect(link?.parentElement?.previousElementSibling?.tagName).toBe('NAV');
    expect(container.textContent).toContain('Cost $0.42');
    expect(container.textContent).toContain('Settings');
  });

  it('updates and clears subtitles without removing independently registered actions', () => {
    act(() => root.render(createElement(Surface, { subtitle: 'First parent' })));
    act(() => root.render(createElement(Surface, { subtitle: 'Second parent' })));
    expect(container.textContent).not.toContain('First parent');
    expect(container.textContent).toContain('Second parent');

    act(() => root.render(createElement(Surface)));
    expect(container.textContent).not.toContain('Second parent');

    act(() => root.render(createElement(Surface, { subtitle: 'Last parent' })));
    act(() => root.render(createElement(Surface, { registered: false })));
    expect(container.textContent).not.toContain('Last parent');
    expect(container.textContent).not.toContain('Authentication fix');
    expect(container.textContent).not.toContain('Cost $0.42');
    expect(container.textContent).toContain('Settings');
  });
});
