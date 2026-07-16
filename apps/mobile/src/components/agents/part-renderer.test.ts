import { type ReasoningPart } from 'cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { PartRenderer } from './part-renderer';
import { ReasoningPartRenderer } from './reasoning-part-renderer';

vi.mock('./child-session-section', () => ({}));
vi.mock('./compaction-separator', () => ({
  CompactionSeparator: () => null,
}));
vi.mock('./file-part-renderer', () => ({
  FilePartRenderer: () => null,
}));
vi.mock('./message-error-boundary', () => ({
  MessageErrorBoundary: ({ children }: { children?: unknown }) => children,
}));
vi.mock('./reasoning-part-renderer', () => ({
  ReasoningPartRenderer: () => null,
}));
vi.mock('./text-part-renderer', () => ({
  TextPartRenderer: () => null,
}));
vi.mock('./tool-part-renderer', () => ({
  ToolPartRenderer: () => null,
}));

function makeReasoningPart(text: string, ended = true): ReasoningPart {
  return {
    id: 'r1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text,
    time: { start: 1, end: ended ? 2 : undefined },
  };
}

describe('PartRenderer', () => {
  it('does not mount a completed empty reasoning part', () => {
    const part = makeReasoningPart('', true);
    // Intentionally invoke the component directly to test the routing seam
    // without pulling in React Native in the node test environment.
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, isStreaming: true });
    expect(result).toBeNull();
  });

  it('renders completed meaningful reasoning through the renderer seam', () => {
    const part = makeReasoningPart('Meaningful reasoning text', true);
    // eslint-disable-next-line new-cap
    const result = PartRenderer({ part, isStreaming: true });
    expect(result).not.toBeNull();
    const reasoningElement = (
      result as unknown as {
        props: { children: { type: unknown; props: Record<string, unknown> } };
      }
    ).props.children;
    expect(reasoningElement.type).toBe(ReasoningPartRenderer);
    expect(reasoningElement.props).toMatchObject({
      text: 'Meaningful reasoning text',
      isStreaming: false,
    });
  });
});
