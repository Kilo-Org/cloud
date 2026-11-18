import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import { act, TestRenderer } from '@/test/renderer';

import { AttachmentChipErrorBoundary } from './attachment-chip-error-boundary';

vi.mock('react-native', () => ({ Image: 'Image', Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type BoundaryRenderer = TestRenderer.ReactTestRenderer;

let events: TelemetryEvent[] = [];
const mounted: BoundaryRenderer[] = [];

beforeEach(() => {
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
  setTelemetrySink(null);
});

function ThrowingChip(): never {
  throw new TypeError('cannot read properties of undefined');
}

async function mount(
  child: ReactNode,
  onRemove: (id: string) => void = () => undefined
): Promise<BoundaryRenderer> {
  const holder: { current: BoundaryRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(
      <AttachmentChipErrorBoundary attachmentId="a1" filename="photo.heic" onRemove={onRemove}>
        {child}
      </AttachmentChipErrorBoundary>
    );
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}

describe('AttachmentChipErrorBoundary', () => {
  it('renders the chip unchanged when the chip renders', async () => {
    const renderer = await mount(<Chip />);

    expect(renderer.root.findAllByType(Chip)).toHaveLength(1);
    expect(renderer.root.findAllByType('Pressable' as never)).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('keeps the strip alive and names the failure when one chip throws', async () => {
    const renderer = await mount(<ThrowingChip />, () => undefined);

    expect(renderer.root.findAllByType(ThrowingChip)).toHaveLength(0);
    const fallback = renderer.root.findByType('Pressable' as never);
    expect(fallback.props.accessibilityLabel).toBe(i18n.t('chat.attachment.attachFailed'));
    expect(fallback.props.accessibilityHint).toBe(
      i18n.t('agentChat.attachmentPreview.removeAttachment', { filename: 'photo.heic' })
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      'error.subsystem': 'agent-attachments',
      'error.operation': 'render_chip',
    });
    expect(events[0]?.fingerprint?.slice(0, 2)).toEqual(['agent-attachments', 'render_chip']);
  });

  it('removes the attachment that could not render', async () => {
    const removed: string[] = [];
    const renderer = await mount(<ThrowingChip />, id => {
      removed.push(id);
    });

    const press = renderer.root.findByType('Pressable' as never).props.onPress as () => void;
    act(() => {
      press();
    });
    expect(removed).toEqual(['a1']);
  });
});

function Chip(): ReactNode {
  return null;
}
