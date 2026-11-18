import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModeCombobox, NEXT_MODE_OPTIONS } from './ModeCombobox';

const previousReact = Reflect.get(globalThis, 'React');
beforeAll(() => Object.assign(globalThis, { React }));
afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Object.assign(globalThis, { React: previousReact });
});

describe('ModeCombobox selected label', () => {
  it.each(['compact', 'full'] as const)(
    'shows an unlisted current mode in the %s picker',
    variant => {
      const html = renderToStaticMarkup(
        createElement(ModeCombobox, {
          value: 'subagent-only',
          options: NEXT_MODE_OPTIONS,
          onValueChange: () => {},
          variant,
        })
      );

      expect(html).toContain('subagent-only');
      expect(html).not.toContain('Select mode');
    }
  );

  it.each([undefined, ''])('shows the placeholder for an empty mode: %p', value => {
    const html = renderToStaticMarkup(
      createElement(ModeCombobox, { value, onValueChange: () => {} })
    );

    expect(html).toContain('Select mode');
  });
});
