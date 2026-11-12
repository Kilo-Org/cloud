import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OlderMessagesHeader } from './OlderMessagesHeader';

Object.assign(globalThis, { React });

it('keeps older history reachable even when the first page does not fill the viewport', () => {
  const html = renderToStaticMarkup(
    createElement(OlderMessagesHeader, {
      hasOlderMessages: true,
      isLoadingOlderMessages: false,
      olderMessagesError: null,
      olderMessagesOmittedItemCount: 0,
      onRetry: jest.fn(),
    })
  );
  expect(html).toContain('Load earlier messages');
  expect(html).not.toContain('disabled=""');
});
