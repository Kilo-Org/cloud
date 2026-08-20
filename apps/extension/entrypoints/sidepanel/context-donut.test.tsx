/* eslint-disable no-unsafe-type-assertion -- DOM queries return HTMLElement; the donut renders buttons and divs. */
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ContextDonut } from './context-donut';

const CONTEXT_LENGTH = 1000;
const PROMPT_TOKENS = 500;
const SESSION_COST_USD = 0.25;

const popoverClass = (container: HTMLElement): string => {
  const node = container.querySelector('details > div');
  if (node === null) {
    throw new Error('Popover is missing.');
  }

  return node.className;
};

describe('context donut rendering', () => {
  it('omits the compact button when the caller has no compaction', () => {
    const { queryByRole } = render(
      <ContextDonut
        contextLength={CONTEXT_LENGTH}
        placement="below"
        promptTokens={PROMPT_TOKENS}
        sessionCostUsd={SESSION_COST_USD}
      />
    );

    expect(queryByRole('button', { name: 'Compact now' })).toBeNull();
  });

  it('renders the compact button disabled until compaction is possible', () => {
    const onCompact = vi.fn();
    const { getByRole, rerender } = render(
      <ContextDonut
        canCompact={false}
        contextLength={CONTEXT_LENGTH}
        onCompact={onCompact}
        placement="above"
        promptTokens={PROMPT_TOKENS}
        sessionCostUsd={SESSION_COST_USD}
      />
    );

    expect((getByRole('button', { name: 'Compact now' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <ContextDonut
        canCompact
        contextLength={CONTEXT_LENGTH}
        onCompact={onCompact}
        placement="above"
        promptTokens={PROMPT_TOKENS}
        sessionCostUsd={SESSION_COST_USD}
      />
    );
    const button = getByRole('button', { name: 'Compact now' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    // eslint-disable-next-line vitest/prefer-called-times -- current linter requires CalledOnce; avoiding contradiction
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it('anchors the popover on the requested side', () => {
    const above = render(
      <ContextDonut
        contextLength={CONTEXT_LENGTH}
        placement="above"
        promptTokens={PROMPT_TOKENS}
        sessionCostUsd={SESSION_COST_USD}
      />
    );
    expect(popoverClass(above.container)).toContain('bottom-10');
    expect(popoverClass(above.container)).not.toContain('top-10');

    const below = render(
      <ContextDonut
        contextLength={CONTEXT_LENGTH}
        placement="below"
        promptTokens={PROMPT_TOKENS}
        sessionCostUsd={SESSION_COST_USD}
      />
    );
    expect(popoverClass(below.container)).toContain('top-10');
    expect(popoverClass(below.container)).not.toContain('bottom-10');
  });

  it('keeps the context usage label the browser-tab e2e specs query', () => {
    const { getByLabelText } = render(
      <ContextDonut
        contextLength={CONTEXT_LENGTH}
        placement="above"
        promptTokens={PROMPT_TOKENS}
        sessionCostUsd={SESSION_COST_USD}
      />
    );

    expect(getByLabelText('Context usage: 500 / 1,000 tokens (50%)')).not.toBeNull();
  });
});
