import { describe, expect, it } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PoolModalityCoverage } from '@/lib/auto-routing-pool-modality';
import { PoolModalityWarning } from './PoolModalityWarning';

function render(coverage: PoolModalityCoverage): string {
  return renderToStaticMarkup(createElement(PoolModalityWarning, { coverage }));
}

describe('PoolModalityWarning', () => {
  it('renders nothing for a fully covered pool', () => {
    expect(render({ status: 'covered' })).toBe('');
  });

  it('names the missing modality and the default-model fallback', () => {
    const html = render({ status: 'missing', missing: ['image'] });
    expect(html).toContain('No model in this pool accepts image input.');
    expect(html).toContain('fall back to the default model.');
  });

  it('reports unknown coverage instead of claiming a gap', () => {
    const html = render({ status: 'unknown', unknownModelIds: ['ghost'] });
    expect(html).toContain('Modality coverage is unknown');
    expect(html).not.toContain('No model in this pool accepts');
  });
});
