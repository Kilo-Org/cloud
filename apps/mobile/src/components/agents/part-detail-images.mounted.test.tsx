import '@/i18n';
import { type FilePart, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { act, createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/test/render-with-providers';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PartDetailSheet } from './part-detail-sheet';

type Renderer = Awaited<ReturnType<typeof renderWithProviders>>['renderer'];
type Instance = Renderer['root'];

const cache = vi.hoisted(() => new Map<string, string>());
vi.mock('./tool-card-image-cache', () => ({ useToolCardImageUri: (id: string) => cache.get(id) }));
vi.mock('react-native', () => ({
  Modal: 'Modal',
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  ImageOff: 'ImageOff',
  FileIcon: 'FileIcon',
  Share2: 'Share2',
  Eye: 'Eye',
  Plug: 'Plug',
}));
vi.mock('@/components/image-viewer-modal', () => ({ ImageViewerModal: 'ImageViewerModal' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#000', mutedForeground: '#666' }),
}));
vi.mock('@/lib/share-remote-file', () => ({
  getShareRemoteFileReason: vi.fn(),
  shareLocalFile: vi.fn(),
  ShareRemoteFileError: Error,
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('./mono-scroll-block', () => ({
  MonoScrollBlock: 'MonoScrollBlock',
  MonoScrollSheetProvider: 'MonoScrollSheetProvider',
}));
vi.mock('./chat-markdown-text', () => ({ ChatMarkdownText: 'ChatMarkdownText' }));
vi.mock('./code-block', () => ({ CodeBlock: 'CodeBlock' }));
vi.mock('./fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('./tool-cards', async () => {
  const { ReadToolCardBody } = await import('./tool-cards/read-tool-card');
  const { GenericToolCardBody } = await import('./tool-cards/generic-tool-card');
  return {
    ReadToolCardBody,
    GenericToolCardBody,
    BashToolCardBody: 'BashToolCardBody',
    EditToolCardBody: 'EditToolCardBody',
    GlobToolCardBody: 'GlobToolCardBody',
    GrepToolCardBody: 'GrepToolCardBody',
    ListToolCardBody: 'ListToolCardBody',
    PatchToolCardBody: 'PatchToolCardBody',
    TaskToolCardBody: 'TaskToolCardBody',
    TodoToolCardBody: 'TodoToolCardBody',
    WebSearchToolCardBody: 'WebSearchToolCardBody',
    WriteToolCardBody: 'WriteToolCardBody',
  };
});

const image: FilePart = {
  id: 'image-1',
  sessionID: 's1',
  messageID: 'm1',
  type: 'file',
  mime: 'image/png',
  url: '',
};
const completedState: Extract<ToolPart['state'], { status: 'completed' }> = {
  status: 'completed',
  input: { filePath: 'image.png' },
  output: 'Image read successfully',
  title: 'read',
  metadata: {},
  time: { start: 1, end: 2 },
  attachments: [image],
};
function makePart(state = completedState): ToolPart {
  return {
    id: 'part-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'call-1',
    tool: 'read',
    state,
  };
}
function sheet(part: ToolPart, visible = true) {
  return createElement(PartDetailSheet, { part, visible, onClose: vi.fn<() => void>() });
}
async function mount(part: ToolPart) {
  const result = await renderWithProviders(sheet(part));
  return {
    ...result,
    update: (next: ToolPart, visible = true) => {
      act(() => {
        result.renderer.update(
          createElement(QueryClientProvider, { client: result.queryClient }, sheet(next, visible))
        );
      });
    },
  };
}
function nodes(root: Instance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}
function failImage(renderer: Renderer) {
  const node = nodes(renderer.root, 'Image')[0];
  if (!node) {
    throw new Error('image was not rendered');
  }
  act(() => {
    (node.props.onError as () => void)();
  });
}
function unavailable(root: Instance) {
  return nodes(root, 'Text').filter(node => node.props.children === 'Image unavailable');
}

beforeEach(() => {
  cache.clear();
  cache.set('part-1', 'file:///image.png');
});

describe('PartDetailSheet image failures', () => {
  it.each([1, 2])(
    'centers all rendered failures with %i attachment records without resetting on wrapper changes',
    async count => {
      const part = makePart({
        ...completedState,
        attachments: Array.from({ length: count }, (_, index) => ({
          ...image,
          id: `image-${index}`,
        })),
      });
      const { renderer, update, unmount } = await mount(part);
      expect(nodes(renderer.root, 'Image')).toHaveLength(1);
      failImage(renderer);
      expect(unavailable(renderer.root)).toHaveLength(1);
      expect(nodes(renderer.root, 'CenteredState')).toHaveLength(1);
      expect(nodes(renderer.root, 'ScrollView')).toHaveLength(0);
      expect(nodes(renderer.root, 'Image')).toHaveLength(0);
      update({ ...part });
      expect(unavailable(renderer.root)).toHaveLength(1);
      expect(nodes(renderer.root, 'Image')).toHaveLength(0);
      update({ ...part, tool: 'custom_tool' });
      expect(nodes(renderer.root, 'CenteredState')).toHaveLength(0);
      expect(unavailable(renderer.root)).toHaveLength(1);
      expect(nodes(renderer.root, 'Image')).toHaveLength(0);
      update(part);
      expect(nodes(renderer.root, 'CenteredState')).toHaveLength(1);
      expect(unavailable(renderer.root)).toHaveLength(1);
      expect(nodes(renderer.root, 'Image')).toHaveLength(0);
      unmount();
    }
  );

  it('keeps the first successful image inline with additional uncached attachment records', async () => {
    const { renderer, unmount } = await mount(
      makePart({ ...completedState, attachments: [image, { ...image, id: 'uncached-image' }] })
    );
    const node = nodes(renderer.root, 'Image')[0];
    if (!node) {
      throw new Error('image was not rendered');
    }
    act(() => {
      (node.props.onLoad as (event: { source: { width: number; height: number } }) => void)({
        source: { width: 100, height: 100 },
      });
    });
    expect(nodes(renderer.root, 'Image')).toHaveLength(1);
    expect(nodes(renderer.root, 'CenteredState')).toHaveLength(0);
    expect(nodes(renderer.root, 'ScrollView')).toHaveLength(1);
    unmount();
  });

  it('keeps partial success inline when an image fails but a cached file remains available', async () => {
    const part = {
      ...makePart({
        ...completedState,
        input: {},
        output: '',
        attachments: [
          image,
          { ...image, id: 'file-1', mime: 'application/pdf', filename: 'report.pdf' },
        ],
      }),
      tool: 'send_file',
    };
    const { renderer, unmount } = await mount(part);
    failImage(renderer);
    expect(unavailable(renderer.root)).toHaveLength(1);
    expect(nodes(renderer.root, 'Text').some(node => node.props.children === 'report.pdf')).toBe(
      true
    );
    expect(nodes(renderer.root, 'CenteredState')).toHaveLength(0);
    expect(nodes(renderer.root, 'ScrollView')).toHaveLength(1);
    unmount();
  });

  it.each(['markdown', 'output'])(
    'keeps substantive %s inline after image failure',
    async content => {
      const part =
        content === 'markdown'
          ? makePart({
              ...completedState,
              input: { filePath: 'readme.md' },
              metadata: {
                display: {
                  type: 'file',
                  path: 'readme.md',
                  text: '# Retained',
                  lineStart: 1,
                  lineEnd: 1,
                  totalLines: 1,
                },
              },
            })
          : {
              ...makePart({ ...completedState, input: {}, output: 'Retained output' }),
              tool: 'custom_tool',
            };
      const { renderer, unmount } = await mount(part);
      failImage(renderer);
      expect(unavailable(renderer.root)).toHaveLength(1);
      expect(nodes(renderer.root, 'CenteredState')).toHaveLength(0);
      expect(nodes(renderer.root, 'ScrollView')).toHaveLength(1);
      if (content === 'markdown') {
        expect(nodes(renderer.root, 'ChatMarkdownText')[0]?.props.value).toBe('# Retained');
      } else {
        expect(nodes(renderer.root, 'MonoScrollBlock')[0]?.props.content).toBe('Retained output');
      }
      unmount();
    }
  );

  it('ignores a late decode failure from a replaced URI', async () => {
    const part = makePart();
    const { renderer, update, unmount } = await mount(part);
    const imageNode = nodes(renderer.root, 'Image')[0];
    if (!imageNode) {
      throw new Error('image was not rendered');
    }
    const onError = imageNode.props.onError as () => void;
    cache.set(part.id, 'file:///replacement.png');
    update(part);
    act(onError);
    expect(nodes(renderer.root, 'CenteredState')).toHaveLength(0);
    expect(nodes(renderer.root, 'Image')).toHaveLength(1);
    expect(unavailable(renderer.root)).toHaveLength(0);
    unmount();
  });

  it.each(['uri', 'part', 'reopen'])('resets the failure for a changed %s', async reset => {
    const part = makePart();
    const { renderer, update, unmount } = await mount(part);
    failImage(renderer);
    expect(nodes(renderer.root, 'CenteredState')).toHaveLength(1);
    if (reset === 'uri') {
      cache.set(part.id, 'file:///replacement.png');
      update(part);
    } else if (reset === 'part') {
      cache.set('part-2', 'file:///image.png');
      update({ ...part, id: 'part-2' });
    } else {
      update(part, false);
      update(part);
    }
    expect(nodes(renderer.root, 'CenteredState')).toHaveLength(0);
    expect(nodes(renderer.root, 'Image')).toHaveLength(1);
    expect(unavailable(renderer.root)).toHaveLength(0);
    failImage(renderer);
    expect(nodes(renderer.root, 'CenteredState')).toHaveLength(1);
    expect(unavailable(renderer.root)).toHaveLength(1);
    unmount();
  });
});
