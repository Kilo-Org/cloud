/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest mocks must be registered before loading the component. */
// The development login panel is a dev-only helper. It used to float over the
// sign-in form, covering the form's own "Continue with Email" label and field
// while the page text showed through it, so two labels occupied the same space.
// A fixed bottom-left overlay can sit under the centered sign-in form at every
// width where the two share the page: the form is `max-w-sm` (384px) centered,
// so its left edge stays left of the panel's right edge (24px + 320px = 344px)
// until the viewport is roughly 1787px wide. The panel therefore stays in the
// page flow at every viewport width, where it cannot overlap the form.
import { jest } from '@jest/globals';
import * as React from 'react';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

// The jest transform compiles JSX with the classic runtime, which resolves a
// global `React`; the app itself is built with the automatic runtime. Supply it
// so this component and its children can be rendered in this suite.
(globalThis as { React?: typeof React }).React = React;

const { FakeLoginForm } = require('./FakeLoginForm') as {
  FakeLoginForm: (props: { searchParams: Record<string, string> }) => ReactElement;
};

function renderPanel(searchParams: Record<string, string> = {}): string {
  return renderToStaticMarkup(createElement(FakeLoginForm, { searchParams }));
}

// The panel is the component's single root element, so the first class
// attribute in the markup is the panel's own.
function panelClassNames(searchParams: Record<string, string> = {}): string[] {
  const match = renderPanel(searchParams).match(/^<div class="([^"]*)"/);
  if (!match) {
    throw new Error('The panel root element with a class attribute is missing.');
  }
  return match[1].split(' ');
}

describe('FakeLoginForm development login panel placement', () => {
  it('stays in the page flow at every viewport width so it cannot cover the sign-in form', () => {
    const classNames = panelClassNames();

    expect(classNames).toContain('relative');
    expect(classNames).toContain('w-full');

    // Any `fixed` at any breakpoint puts the panel back over the centered form.
    expect(classNames.filter(name => name === 'fixed' || name.endsWith(':fixed'))).toEqual([]);

    for (const floatingClass of [
      'bottom-6',
      'left-6',
      'w-80',
      'sm:bottom-6',
      'sm:left-6',
      'sm:z-50',
      'sm:w-80',
    ]) {
      expect(classNames).not.toContain(floatingClass);
    }
  });

  it('keeps an opaque panel background so page text cannot show through it', () => {
    expect(panelClassNames()).toContain('bg-gray-900');
  });
});

describe('FakeLoginForm developer controls', () => {
  it('renders the labeled email field and the sign-in action', () => {
    const html = renderPanel();

    expect(html).toContain('Development Login');
    expect(html).toContain('Email Address');
    expect(html).toContain('id="fake-email"');
    expect(html).toContain('Sign In');
    expect(html).toContain('aria-label="Close dev login"');
  });
});
