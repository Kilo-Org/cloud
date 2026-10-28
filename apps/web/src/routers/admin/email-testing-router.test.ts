import { describe, expect, it } from '@jest/globals';
import { renderTemplate, subjects, type TemplateName } from '@kilocode/web-shared/lib/email';
import { fixtureTemplateVars } from './email-testing-router';

/**
 * The admin email-testing page previews whatever `getTemplates` lists, so every
 * registered subject needs a fixture that satisfies its template. A missing
 * case throws `Unknown template`, and a fixture missing one of the template's
 * variables throws `Missing template variable` — both break the preview.
 */
describe('admin email-testing fixtures', () => {
  it('renders support in the Code Reviewer preview copy and recovery link', () => {
    const html = renderTemplate('codeReviewDisabled', {
      ...fixtureTemplateVars('codeReviewDisabled'),
      year: '2026',
    });

    expect(html).toContain('Contact hi@kilo.ai for help');
    expect(html).toContain('href="mailto:hi@kilo.ai?subject=Repository%20clone%20timeouts"');
    expect(html).toContain('reply to this email or contact hi@kilo.ai.');
  });

  it.each(Object.keys(subjects) as TemplateName[])('renders the %s preview', template => {
    const html = renderTemplate(template, {
      ...fixtureTemplateVars(template),
      year: '2026',
    });

    expect(html.length).toBeGreaterThan(0);
    // Every placeholder resolved: an unresolved one means the fixture is short.
    expect(html).not.toMatch(/\{\{/);
  });
});
