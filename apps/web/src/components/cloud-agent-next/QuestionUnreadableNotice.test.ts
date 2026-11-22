import { describe, expect, it } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { QuestionUnreadableNotice } from './QuestionUnreadableNotice';

describe('QuestionUnreadableNotice', () => {
  it('announces a waiting question the app cannot show', () => {
    const html = renderToStaticMarkup(createElement(QuestionUnreadableNotice));

    expect(html).toContain('role="alert"');
    expect(html).toContain('Question could not be displayed');
    expect(html).toContain('The agent is waiting on a question this app cannot show.');
    expect(html).toContain('Answer the question in the CLI to continue.');
  });

  it('offers no answer action for a question that carried no readable options', () => {
    const html = renderToStaticMarkup(createElement(QuestionUnreadableNotice));

    expect(html).not.toContain('<button');
  });
});
