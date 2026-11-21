import { describe, expect, it } from 'vitest';

import { flagPicked, flagRefused } from '@/lib/chat/chat-flag';

import { kiloServerRow, mcpSettingsView, settingsToolsView } from './mcp-settings-state';
import { saved, tool } from './mcp-settings-state.test-helpers';

/**
 * The five states the Kilo MCP control draws.
 *
 * The connection is the module's (`KiloMcpState`), the setting is the chat's,
 * and this is the one place the two become what the sheet shows. Each state is
 * pinned here: the line, the count, the switch, and whether a Retry is offered.
 * The remote servers the same sheet lists are pinned in
 * `mcp-settings-state-remote-servers.test.ts`.
 */

describe('what the Kilo MCP sheet shows', () => {
  it('lists the tools the server answered with, and offers no CTA', () => {
    const view = mcpSettingsView(
      { status: 'ready', tools: [tool('mcp_kilo_read-file'), tool('mcp_kilo_list-files')] },
      saved(true)
    );

    expect(view).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.available',
      toolCount: 2,
      retry: false,
      busy: false,
    });
  });

  it('offers a Retry when the server could not be reached', () => {
    const view = mcpSettingsView(
      { status: 'failed', kind: 'unreachable', retryable: true },
      saved(true)
    );

    expect(view).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.unreachable',
      retry: true,
      busy: false,
    });
  });

  it('names a refused credential, and still offers a Retry', () => {
    const view = mcpSettingsView(
      { status: 'failed', kind: 'unauthorized', retryable: true },
      saved(true)
    );

    expect(view).toMatchObject({
      statusKey: 'modelChat.mcp.unauthorized',
      retry: true,
    });
  });

  it('offers no CTA, reads off, and locks the switch when the server is not there', () => {
    const view = mcpSettingsView(
      { status: 'failed', kind: 'missing', retryable: false },
      saved(true)
    );

    /* The setting is still on, so a tap would write what is already stored and
       the switch would snap back: a live switch here does nothing. */
    expect(view).toMatchObject({
      enabled: false,
      toggleable: false,
      statusKey: 'modelChat.mcp.unavailable',
      retry: false,
    });
  });

  it('says there are none when the server answered with an empty list', () => {
    const view = mcpSettingsView({ status: 'ready', tools: [] }, saved(true));

    /* The answer is still worth asking again — the retry reconnects and
       reports what the server offers now — so the sheet draws the Retry. */
    expect(view).toMatchObject({
      enabled: true,
      toggleable: true,
      statusKey: 'modelChat.mcp.none',
      descriptionKey: 'modelChat.mcp.noneDescription',
      toolCount: 0,
      busy: false,
      tone: 'warn',
      retry: true,
    });
  });

  it('reads off, with no server contacted, when the chat has the setting off', () => {
    const view = mcpSettingsView(
      { status: 'ready', tools: [tool('mcp_kilo_read-file')] },
      saved(false)
    );

    expect(view).toMatchObject({
      enabled: false,
      toggleable: true,
      statusKey: 'modelChat.mcp.off',
      toolCount: 0,
      retry: false,
      busy: false,
    });
  });

  it('shows the switch working while a discovery is in flight', () => {
    const view = mcpSettingsView({ status: 'connecting' }, saved(true));

    expect(view).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.connecting',
      busy: true,
      retry: false,
    });
  });

  it('draws a saved on-choice this chat is not on with the not-applied line and a Retry', () => {
    const view = mcpSettingsView(
      { status: 'ready', tools: [tool('mcp_kilo_read-file')] },
      saved(true, 'behind')
    );

    /* The choice is the person's and the store holds it; only this session is
       not on it, so the switch keeps the saved value and the recovery is a
       Retry rather than a second tap. */
    expect(view).toMatchObject({
      enabled: true,
      toggleable: true,
      statusKey: 'modelChat.mcp.notApplied',
      descriptionKey: 'modelChat.mcp.notAppliedDescription',
      toolCount: 0,
      retry: true,
      busy: false,
      tone: 'warn',
    });
  });

  it('draws a saved off-choice this chat is not on as off, not as on', () => {
    const view = mcpSettingsView(
      { status: 'ready', tools: [tool('mcp_kilo_read-file')] },
      saved(false, 'behind')
    );

    expect(view).toMatchObject({
      enabled: false,
      toggleable: true,
      statusKey: 'modelChat.mcp.notApplied',
      retry: true,
    });
  });

  it.each([false, true])('keeps Retry when persisting the opposite of %s is refused', choice => {
    const flag = flagRefused(flagPicked(saved(choice, 'behind'), !choice));
    const view = mcpSettingsView({ status: 'ready', tools: [tool('mcp_kilo_read-file')] }, flag);

    expect(view).toMatchObject({
      enabled: choice,
      statusKey: 'modelChat.mcp.notApplied',
      retry: true,
    });
  });
});

describe('the settings tools switch', () => {
  it('reads on and green when the group is sent to the model', () => {
    expect(settingsToolsView(true)).toEqual({
      titleKey: 'modelChat.mcp.settingsToolsTitle',
      subtitleKey: 'modelChat.mcp.settingsToolsSubtitle',
      statusKey: 'modelChat.mcp.settingsToolsOn',
      tone: 'good',
    });
  });

  it('reads off and grey when the group is not sent', () => {
    expect(settingsToolsView(false)).toMatchObject({
      statusKey: 'modelChat.mcp.settingsToolsOff',
      tone: 'muted',
    });
  });
});

describe('the Kilo row', () => {
  it('offers enable and disable only', () => {
    const row = kiloServerRow(mcpSettingsView({ status: 'ready', tools: [] }, saved(true)));

    expect(row).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.none',
      canEdit: false,
      canDelete: false,
    });
  });

  it('carries the view it was given, so the sheet draws one row shape', () => {
    const view = mcpSettingsView(
      { status: 'failed', kind: 'unreachable', retryable: true },
      saved(true)
    );

    expect(kiloServerRow(view)).toEqual({ ...view, canEdit: false, canDelete: false });
  });
});
