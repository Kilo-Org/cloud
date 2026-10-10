import { describe, expect, it, vi } from 'vitest';

// The mock harness is imported before any product module so its `vi.mock`
// calls register before the modules under test are loaded.
import { findConfigureRows, mountProfile } from '@/components/profile-screen.test-helpers';
import { i18n } from '@/i18n';
import { waitFor } from '@/test/render-with-providers';

// The harness does not mock the safe-area context, so this spec owns that, like
// the sibling profile specs.
const safeArea = vi.hoisted(() => ({ top: 24, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea,
}));

/**
 * The profile screen is a list of destinations, so the row palette gives every
 * row its section's hue (`agent-color.ts`, destination table). A row with no hue
 * falls back to the neutral tile, which reads as a disabled row beside its
 * coloured siblings — the agent-profile row did exactly that between Code
 * Reviewer and Security Agent.
 */
describe('ProfileScreen row hues', () => {
  async function mountWithAgentRows() {
    const view = await mountProfile();
    await waitFor(() => findConfigureRows(view.renderer.root, i18n.t('profiles.title')).length > 0);
    return view.renderer.root;
  }

  it('gives every destination row a hue from the palette', async () => {
    const root = await mountWithAgentRows();
    const rows = root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
    );
    expect(rows.length).toBeGreaterThan(0);
    const neutral = rows
      .filter(row => row.props.hue === undefined && row.props.tone === undefined)
      .map(row => String(row.props.title));
    expect(neutral).toEqual([]);
  });

  it('gives the agent-profile row the hue of the section it sits in', async () => {
    const root = await mountWithAgentRows();
    const [row] = findConfigureRows(root, i18n.t('profiles.title'));
    // The Agents step. The row lists the agent profiles, beside Code Reviewer
    // and Security Agent, which already carry it.
    expect(row?.props.hue).toBe('honey');
  });
});
