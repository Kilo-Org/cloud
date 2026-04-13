import { buildGoogleTagManagerScript, buildImpactUttScript } from '@/lib/marketing-tag-scripts';

describe('marketing tag scripts', () => {
  it('escapes GTM IDs embedded into bootstrap JavaScript', () => {
    const script = buildGoogleTagManagerScript(`GTM-TEST';alert(1);//`);

    expect(script).toContain(JSON.stringify(`GTM-TEST';alert(1);//`));
    expect(script).not.toContain(`GTM-TEST';alert(1);//');`);
  });

  it('escapes Impact IDs embedded into bootstrap JavaScript', () => {
    const script = buildImpactUttScript(`impact';alert(1);//`);

    expect(script).toContain(JSON.stringify(`https://utt.impactcdn.com/impact';alert(1);//.js`));
    expect(script).not.toContain(`impact';alert(1);//.js','script'`);
  });
});
