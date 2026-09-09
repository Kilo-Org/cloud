/* eslint-disable typescript-eslint/no-deprecated -- Use the repository's DOM-free mounted renderer. */
import { type ElementType, type ReactElement } from 'react';
import { type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { KiloClawCard } from '@/components/kiloclaw/instance-card';
import { StatusCard } from '@/components/kiloclaw/status-card';
import { type GatewayState } from '@/lib/hooks/use-kiloclaw-queries';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  AppContext: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => undefined }),
  },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/icons', () => ({
  Activity: 'Activity',
  AlertTriangle: 'AlertTriangle',
  Cpu: 'Cpu',
  ExternalLink: 'ExternalLink',
  Globe: 'Globe',
  MapPin: 'MapPin',
  MemoryStick: 'MemoryStick',
  RotateCcw: 'RotateCcw',
  Server: 'Server',
  Settings2: 'Settings2',
  Sparkles: 'Sparkles',
}));
vi.mock('@/components/ui/status-dot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/kiloclaw/bot-avatar', () => ({ BotAvatar: 'BotAvatar' }));
vi.mock('@/lib/hooks/use-kiloclaw-queries', () => ({
  useKiloClawStatus: () => ({ data: undefined }),
  useKiloClawStatusQueryKey: () => [],
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666', warn: '#a60' }),
}));

/**
 * The kiloclaw status surfaces render their label in full capitals — the badge
 * and the dashboard hero carry an `uppercase` class, and the catalog keeps the
 * known statuses (`RUNNING`, `STOPPED`, …) and the unknown fallback
 * (`kiloclaw.status.unknown`, "UNKNOWN") uppercase.
 */
async function mount(ui: ReactElement) {
  const { renderer } = await renderWithProviders(ui);
  return renderer.root;
}

function findLabel(root: ReactTestInstance, text: string): ReactTestInstance {
  const nodes = root.findAll(
    (node: ReactTestInstance) =>
      node.type === ('Text' as ElementType) && node.props.children === text
  );
  expect(nodes, `no Text rendering "${text}"`).toHaveLength(1);
  const [node] = nodes;
  if (!node) {
    throw new Error(`no Text rendering "${text}"`);
  }
  return node;
}

describe('kiloclaw status label case', () => {
  it('renders the unknown gateway state uppercase in the status card', async () => {
    const root = await mount(
      <StatusCard
        region={null}
        cpus={null}
        memoryMb={null}
        gatewayState={'draining' as unknown as GatewayState}
        uptime={null}
        restarts={null}
        lastExitCode={null}
        lastExitSignal={null}
      />
    );
    const value = findLabel(root, 'UNKNOWN');
    expect(String(value.props.className)).toContain('uppercase');
  });

  it('keeps the known gateway state uppercase in the status card', async () => {
    const root = await mount(
      <StatusCard
        region={null}
        cpus={null}
        memoryMb={null}
        gatewayState="running"
        uptime={null}
        restarts={null}
        lastExitCode={null}
        lastExitSignal={null}
      />
    );
    const value = findLabel(root, 'RUNNING');
    expect(String(value.props.className)).toContain('uppercase');
  });

  it('renders the unknown instance status uppercase on the instance card', async () => {
    const root = await mount(
      <KiloClawCard
        instance={{
          sandboxId: 'sb-1',
          name: 'Bot One',
          botName: null,
          botEmoji: null,
          organizationId: null,
          organizationName: null,
          status: 'draining',
        }}
      />
    );
    const value = findLabel(root, 'UNKNOWN');
    expect(String(value.props.className)).toContain('uppercase');
  });
});
