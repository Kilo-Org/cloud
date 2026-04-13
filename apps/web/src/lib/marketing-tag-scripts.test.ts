import { buildGoogleTagManagerScript, buildImpactUttScript } from '@/lib/marketing-tag-scripts';

describe('marketing tag scripts', () => {
  it('escapes GTM IDs embedded into bootstrap JavaScript', () => {
    const script = buildGoogleTagManagerScript('GTM-TEST</script><script>alert(1)</script>');

    expect(script).toContain('GTM-TEST\\u003C\\u002Fscript\\u003E');
    expect(script).not.toContain('</script>');
    expect(script).not.toContain('<script>');
  });

  it('escapes Impact IDs embedded into bootstrap JavaScript', () => {
    const script = buildImpactUttScript('impact</script><script>alert(1)</script>');

    expect(script).toContain('https:\\u002F\\u002Futt.impactcdn.com\\u002Fimpact');
    expect(script).toContain('\\u003C\\u002Fscript\\u003E');
    expect(script).not.toContain('</script>');
    expect(script).not.toContain('<script>');
  });
});
