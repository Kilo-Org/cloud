import { type KiloMcpState } from '@/lib/chat/kilo-mcp';

/**
 * What the Kilo MCP control shows, from the connection and the chat's setting.
 *
 * One pure function, so the sheet and the dot on the header control cannot
 * disagree about what the connection means. It is deliberately not a hook: the
 * states a person sees — on with tools, on with none, a failure a Retry can fix,
 * a failure it cannot, and off — are decided here and proved here, and the
 * React around it only draws what this answers.
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
