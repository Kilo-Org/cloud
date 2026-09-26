import { type KiloMcpState } from '@/lib/chat/kilo-mcp';
import { type RemoteMcpServerState } from '@/lib/chat/remote-mcp';
import { type RemoteMcpServerDraft, type StoredRemoteMcpServer } from '@/lib/chat/remote-mcp-store';
import { normalizeRemoteMcpUrl } from '@/lib/chat/remote-mcp-url';

/**
 * What the Kilo MCP control shows, from the connection and the chat's setting.
 *
 * One pure function, so the sheet and the dot on the header control cannot
 * disagree about what the connection means. It is deliberately not a hook: the
 * states a person sees — on with tools, on with none, a failure a Retry can fix,
 * a failure it cannot, and off — are decided here and proved here, and the
 * React around it only draws what this answers.
 *
 * The same module maps the rest of the sheet: the group switch, one row per
 * remote server (and the Kilo row's two missing actions), and whether a server
 * form may be saved. Every decision is here so the sheet, the header dot and
 * the form cannot disagree about what a state means.
 */

/** The line under the switch, named by its key so the sheet draws it directly. */
type McpStatusKey =
  | 'modelChat.mcp.available'
  | 'modelChat.mcp.connecting'
  | 'modelChat.mcp.none'
  | 'modelChat.mcp.off'
  | 'modelChat.mcp.unauthorized'
  | 'modelChat.mcp.unavailable'
  | 'modelChat.mcp.unreachable';

/** The sentence that says what the status means, when one is needed. */
type McpDescriptionKey =
  | 'modelChat.mcp.noneDescription'
  | 'modelChat.mcp.offDescription'
  | 'modelChat.mcp.unauthorizedDescription'
  | 'modelChat.mcp.unavailableDescription'
  | 'modelChat.mcp.unreachableDescription';

/**
 * The dot on the header control. The same four tones `StatusDot` draws: green
 * when the tools are there, amber while a discovery runs or found nothing,
 * red when a server failed, and grey when the chat has the feature off.
 */
type McpTone = 'good' | 'warn' | 'danger' | 'muted';

export type McpSettingsView = {
  /**
   * The switch's position. Off when the chat has the setting off, and off when
   * there is nothing to use: a server that is not there cannot be turned on.
   */
  readonly enabled: boolean;
  /**
   * Whether the switch can be moved. Not when there is nothing to use: the
   * position reads off while the chat's setting is still on, so a tap would
   * only write the setting it already has and the switch would snap back.
   */
  readonly toggleable: boolean;
  readonly statusKey: McpStatusKey;
  readonly descriptionKey: McpDescriptionKey | null;
  readonly toolCount: number;
  /** Whether the sheet offers a Retry. A server that is gone cannot be retried. */
  readonly retry: boolean;
  /** Whether a discovery is in flight, so the switch can show it is working. */
  readonly busy: boolean;
  readonly tone: McpTone;
};

/** The switch is off, so no server was contacted and no tool is sent. */
const OFF: McpSettingsView = {
  enabled: false,
  toggleable: true,
  statusKey: 'modelChat.mcp.off',
  descriptionKey: 'modelChat.mcp.offDescription',
  toolCount: 0,
  retry: false,
  busy: false,
  tone: 'muted',
};

/** A server that is not there (`missing`), or no connection in this build (`idle`). */
function unavailable(tone: McpTone): McpSettingsView {
  return {
    enabled: false,
    toggleable: false,
    statusKey: 'modelChat.mcp.unavailable',
    descriptionKey: 'modelChat.mcp.unavailableDescription',
    toolCount: 0,
    retry: false,
    busy: false,
    tone,
  };
}

/**
 * A failure a Retry can fix: the server is down, the credential was refused, or
 * the protocol was answered wrong. All three are worth asking again, so the
 * switch stays on and the sheet offers the Retry.
 */
function retryable(kind: 'unauthorized' | 'unreachable' | 'missing' | 'protocol'): McpSettingsView {
  const refused = kind === 'unauthorized';
  return {
    enabled: true,
    toggleable: true,
    statusKey: refused ? 'modelChat.mcp.unauthorized' : 'modelChat.mcp.unreachable',
    descriptionKey: refused
      ? 'modelChat.mcp.unauthorizedDescription'
      : 'modelChat.mcp.unreachableDescription',
    toolCount: 0,
    retry: true,
    busy: false,
    tone: 'danger',
  };
}

export function mcpSettingsView(state: KiloMcpState, enabled: boolean): McpSettingsView {
  if (!enabled) {
    return OFF;
  }
  if (state.status === 'connecting') {
    return {
      enabled: true,
      toggleable: true,
      statusKey: 'modelChat.mcp.connecting',
      descriptionKey: null,
      toolCount: 0,
      retry: false,
      busy: true,
      tone: 'warn',
    };
  }
  if (state.status === 'ready') {
    if (state.tools.length === 0) {
      return {
        enabled: true,
        toggleable: true,
        statusKey: 'modelChat.mcp.none',
        descriptionKey: 'modelChat.mcp.noneDescription',
        toolCount: 0,
        retry: false,
        busy: false,
        tone: 'warn',
      };
    }
    return {
      enabled: true,
      toggleable: true,
      statusKey: 'modelChat.mcp.available',
      descriptionKey: null,
      toolCount: state.tools.length,
      retry: false,
      busy: false,
      tone: 'good',
    };
  }
  if (state.status === 'failed' && state.retryable) {
    return retryable(state.kind);
  }
  /* `missing` is a server that is not there any more, and `idle` is a build
     with no server to reach. Neither is a Retry's to fix. */
  return unavailable(state.status === 'failed' ? 'danger' : 'muted');
}

/** The group switch's row, named by key so the sheet draws it directly. */
export type SettingsToolsView = {
  readonly titleKey: 'modelChat.mcp.settingsToolsTitle';
  readonly subtitleKey: 'modelChat.mcp.settingsToolsSubtitle';
  readonly statusKey: 'modelChat.mcp.settingsToolsOn' | 'modelChat.mcp.settingsToolsOff';
  readonly tone: McpTone;
};

/**
 * The one switch for the settings-changing tools.
 *
 * On is green because the tools are sent to the model; off is grey because the
 * group is not. There is no third state: the switch is the whole feature, and
 * the line under it says which way it is.
 */
export function settingsToolsView(enabled: boolean): SettingsToolsView {
  return {
    titleKey: 'modelChat.mcp.settingsToolsTitle',
    subtitleKey: 'modelChat.mcp.settingsToolsSubtitle',
    statusKey: enabled ? 'modelChat.mcp.settingsToolsOn' : 'modelChat.mcp.settingsToolsOff',
    tone: enabled ? 'good' : 'muted',
  };
}

/** The status line under a remote server row, named by its key. */
type RemoteMcpStatusKey =
  | 'modelChat.mcp.none'
  | 'modelChat.mcp.serverChecking'
  | 'modelChat.mcp.serverOff'
  | 'modelChat.mcp.serverToolCount'
  | 'modelChat.mcp.serverUnreachable';

/**
 * One remote server, as a row. It always offers enable, edit and delete: the
 * person added it, so the person may change it or take it away. A server whose
 * discovery failed also offers a Retry, because that is the one thing the row
 * can do about it.
 */
export type RemoteMcpServerRow = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly statusKey: RemoteMcpStatusKey;
  readonly toolCount: number;
  /** Whether the row offers a Retry. Only a failed discovery can be asked again. */
  readonly retry: boolean;
  readonly canEdit: true;
  readonly canDelete: true;
};

/**
 * What one remote server's connection line says.
 *
 * A server that is off says so and is asked nothing. One that has not been
 * reached yet reads as none rather than as a failure, so a row is never blank
 * while the first discovery is in flight. A server that answered with tools
 * counts them; one that answered with none says so.
 */
function remoteStatusKey(
  enabled: boolean,
  state: RemoteMcpServerState | undefined
): RemoteMcpStatusKey {
  if (!enabled) {
    return 'modelChat.mcp.serverOff';
  }
  if (state === undefined || state.status === 'idle') {
    return 'modelChat.mcp.none';
  }
  if (state.status === 'connecting') {
    return 'modelChat.mcp.serverChecking';
  }
  if (state.status === 'failed') {
    return 'modelChat.mcp.serverUnreachable';
  }
  return state.toolCount > 0 ? 'modelChat.mcp.serverToolCount' : 'modelChat.mcp.none';
}

/**
 * Whether a row offers a Retry.
 *
 * Every failed discovery is retryable — the server was down, the credential was
 * refused, or the protocol was answered wrong — so the failure itself is the
 * whole condition. A server that is off is asked nothing and a server that
 * answered is already the answer, so neither offers one.
 */
function remoteRetry(enabled: boolean, state: RemoteMcpServerState | undefined): boolean {
  return enabled && state?.status === 'failed';
}

/**
 * One row per stored server, in the stored order.
 *
 * The stored list decides which rows exist, what they are called and whether
 * they are on; the discovered states add what the connection is doing. A server
 * the discovery has not reached yet still gets a row, so a list that is being
 * checked never loses the servers the person added.
 */
export function remoteServerRows(
  servers: readonly StoredRemoteMcpServer[],
  states: readonly RemoteMcpServerState[]
): readonly RemoteMcpServerRow[] {
  return servers.map(server => {
    const state = states.find(one => one.id === server.id);
    return {
      id: server.id,
      name: server.name,
      url: server.url,
      enabled: server.enabled,
      statusKey: remoteStatusKey(server.enabled, state),
      toolCount: server.enabled ? (state?.toolCount ?? 0) : 0,
      retry: remoteRetry(server.enabled, state),
      canEdit: true,
      canDelete: true,
    };
  });
}

/**
 * The Kilo row: the enable/disable view the sheet already draws, plus the two
 * actions it must not offer.
 *
 * The Kilo server is the build's own, so the person may turn it on or off for a
 * chat and nothing else. `canEdit` and `canDelete` are here so the sheet draws
 * the row from the same shape as a remote one and hides the two actions the
 * same way, rather than special-casing the Kilo server in its markup.
 */
export type KiloMcpServerRow = McpSettingsView & {
  readonly canEdit: false;
  readonly canDelete: false;
};

export function kiloServerRow(view: McpSettingsView): KiloMcpServerRow {
  return { ...view, canEdit: false, canDelete: false };
}

/** The copy a server form shows under a field it cannot save yet. */
type McpFormErrorKey = 'common.required' | 'modelChat.mcp.fieldUrlInvalid';

/** Why a draft cannot be saved, per field. A field that is fine is absent. */
export type McpServerFormErrors = {
  readonly name?: McpFormErrorKey;
  readonly url?: McpFormErrorKey;
};

/** Why a URL cannot be saved: empty, or one the store would not accept. */
function urlErrorFor(url: string): McpFormErrorKey | undefined {
  if (url.trim() === '') {
    return 'common.required';
  }
  try {
    normalizeRemoteMcpUrl(url);
    return undefined;
  } catch {
    return 'modelChat.mcp.fieldUrlInvalid';
  }
}

/**
 * Why a server draft cannot be saved, or null when it can.
 *
 * The name and the URL are required, and the URL is put through the same
 * normalization the store uses: a form that would be refused on save is refused
 * here, so the Save is gated rather than the person's write being thrown away
 * after they made it. The token is optional and never blocks a save.
 */
export function mcpServerFormError(draft: RemoteMcpServerDraft): McpServerFormErrors | null {
  const name: McpFormErrorKey | undefined =
    draft.name.trim() === '' ? 'common.required' : undefined;
  const url = urlErrorFor(draft.url);
  if (name !== undefined && url !== undefined) {
    return { name, url };
  }
  if (name !== undefined) {
    return { name };
  }
  if (url !== undefined) {
    return { url };
  }
  return null;
}
