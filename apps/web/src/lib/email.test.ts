import { renderNonAutolinkedText } from '@/lib/email';

describe('email rendering helpers', () => {
  it('escapes HTML while neutralizing URL autolinking', () => {
    const rendered = renderNonAutolinkedText(
      '<b>https://evil.example</b> www.bad.example acme.com'
    );

    expect(rendered.html).toBe(
      '&lt;b&gt;https:/&#8203;/&#8203;evil.&#8203;example&lt;/&#8203;b&gt; www.&#8203;bad.&#8203;example acme.&#8203;com'
    );
  });
});
