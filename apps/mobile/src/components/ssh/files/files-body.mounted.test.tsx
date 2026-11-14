import { expect, it, vi } from 'vitest';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { FilesBody } from './files-body';
const state = vi.hoisted(() => ({ ready: false }));
vi.mock('@/lib/ssh/session/use-sessions', () => ({ useSshSessionsRehydrated: () => state.ready }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ssh/files/file-row', () => ({ FileRow: 'FileRow' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ FolderOpen: 'FolderOpen' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
it('waits for rehydration before declaring a missing session closed', () => {
  const holder: { mounted?: ReactTestRenderer } = {};
  const render = () => (
    <FilesBody
      session={null}
      connectionId={null}
      phase={{ kind: 'waiting' }}
      entries={[]}
      loading={false}
      refreshing={false}
      onRefresh={vi.fn<() => void>()}
      onRetry={vi.fn<() => void>()}
      onUpload={vi.fn<() => void>()}
      onOpen={vi.fn<() => void>()}
      onLongPress={vi.fn<() => void>()}
      onBackToHosts={vi.fn<() => void>()}
    />
  );
  act(() => {
    holder.mounted = TestRenderer.create(render());
  });
  const mounted = holder.mounted;
  if (!mounted) {
    throw new Error('Files body did not mount');
  }
  expect(JSON.stringify(mounted.toJSON())).not.toContain('ssh.session.closedTitle');
  expect(JSON.stringify(mounted.toJSON())).toContain('Skeleton');
  state.ready = true;
  act(() => {
    mounted.update(render());
  });
  expect(mounted.root.findByProps({ title: 'ssh.session.closedTitle' })).toBeDefined();
  act(() => {
    mounted.unmount();
  });
});
