import { createChannelApprovalCapability } from 'openclaw/plugin-sdk/approval-delivery-runtime';
import type { ChannelApprovalCapability } from 'openclaw/plugin-sdk/channel-contract';
import type {
  ChannelApprovalNativeRuntimeAdapter,
  PendingApprovalView,
  ResolvedApprovalView,
  ExpiredApprovalView,
} from 'openclaw/plugin-sdk/approval-handler-runtime';
import type { ContentBlock, ActionsBlock } from '@kilocode/kilo-chat';
import { createKiloChatClient } from './client.js';
import { resolveControllerUrl, resolveGatewayToken } from './env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the conversationId from a session key.
 *
 * Session keys for kilo-chat follow the pattern:
 *   agent:<agentId>:direct:<conversationId>
 *
 * In the "main" dmScope (the default), buildAgentPeerSessionKey puts the
 * lowercased peerId after `direct:`.
 */
function extractConversationIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(':');
  const directIdx = parts.indexOf('direct');
  if (directIdx === -1 || directIdx >= parts.length - 1) return null;
  // Everything after "direct:" is the peerId (conversationId); rejoin in case
  // it contained colons (unlikely for ULIDs, but defensive).
  // The SDK lowercases the peerId in the session key, but the kilo-chat
  // controller expects the original uppercase ULID.
  const raw = parts.slice(directIdx + 1).join(':');
  return raw ? raw.toUpperCase() : null;
}

function makeClient() {
  return createKiloChatClient({
    controllerBaseUrl: resolveControllerUrl(),
    gatewayToken: resolveGatewayToken(),
  });
}

// ---------------------------------------------------------------------------
// Content-block builders
// ---------------------------------------------------------------------------

function buildMetadataText(
  view: PendingApprovalView | ResolvedApprovalView | ExpiredApprovalView
): string {
  const lines: string[] = [];
  lines.push(`**${view.title}**`);
  if (view.description) lines.push(view.description);
  // Show the command being approved for exec approvals.
  if (view.approvalKind === 'exec') {
    lines.push('');
    lines.push(`\`${view.commandText}\``);
    if (view.commandPreview && view.commandPreview !== view.commandText) {
      lines.push(`_${view.commandPreview}_`);
    }
  }
  if (view.metadata.length > 0) {
    lines.push('');
    for (const m of view.metadata) {
      lines.push(`${m.label}: ${m.value}`);
    }
  }
  return lines.join('\n');
}

function buildPendingBlocks(view: PendingApprovalView): ContentBlock[] {
  const textBlock: ContentBlock = { type: 'text', text: buildMetadataText(view) };
  const actionsBlock: ActionsBlock = {
    type: 'actions',
    groupId: view.approvalId,
    actions: view.actions.map(a => ({
      label: a.label,
      style: a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger' : 'secondary',
      value: a.decision,
    })),
  };
  return [textBlock, actionsBlock];
}

function buildResolvedBlocks(view: ResolvedApprovalView): ContentBlock[] {
  const textBlock: ContentBlock = { type: 'text', text: buildMetadataText(view) };
  const resolvedBy = view.resolvedBy ?? 'unknown';
  const actionsBlock: ActionsBlock = {
    type: 'actions',
    groupId: view.approvalId,
    actions: [],
    resolved: {
      value: view.decision,
      resolvedBy,
      resolvedAt: Date.now(),
    },
  };
  return [textBlock, actionsBlock];
}

function buildExpiredBlocks(view: ExpiredApprovalView): ContentBlock[] {
  const textBlock: ContentBlock = { type: 'text', text: buildMetadataText(view) + '\n\n_Expired_' };
  const actionsBlock: ActionsBlock = {
    type: 'actions',
    groupId: view.approvalId,
    actions: [],
    resolved: {
      value: 'expired',
      resolvedBy: 'system',
      resolvedAt: Date.now(),
    },
  };
  return [textBlock, actionsBlock];
}

// ---------------------------------------------------------------------------
// Pending entry tracking
// ---------------------------------------------------------------------------

type PendingEntry = {
  messageId: string;
  conversationId: string;
  approvalId: string;
};

type PreparedTarget = {
  conversationId: string;
};

// ---------------------------------------------------------------------------
// Native runtime adapter
// ---------------------------------------------------------------------------

const nativeRuntime: ChannelApprovalNativeRuntimeAdapter<
  ContentBlock[], // TPendingPayload
  PreparedTarget, // TPreparedTarget
  PendingEntry, // TPendingEntry
  never, // TBinding (unused)
  ContentBlock[] // TFinalPayload
> = {
  eventKinds: ['exec', 'plugin'],

  availability: {
    isConfigured: (...args: unknown[]) => {
      console.log('[kilo-chat:approval] isConfigured called', JSON.stringify(args));
      return true;
    },
    shouldHandle: (...args: unknown[]) => {
      console.log('[kilo-chat:approval] shouldHandle called', JSON.stringify(args));
      return true;
    },
  },

  presentation: {
    buildPendingPayload: ({ view }) => buildPendingBlocks(view),

    buildResolvedResult: ({ view }) => ({
      action: 'update' as const,
      payload: buildResolvedBlocks(view),
    }),

    buildExpiredResult: ({ view }) => ({
      action: 'update' as const,
      payload: buildExpiredBlocks(view),
    }),
  },

  transport: {
    prepareTarget: ({ request }) => {
      const sessionKey = request.request?.sessionKey;
      console.log('[kilo-chat:approval] prepareTarget sessionKey:', sessionKey ?? '(none)');
      if (!sessionKey) {
        console.log('[kilo-chat:approval] prepareTarget → null (no sessionKey)');
        return null;
      }
      const conversationId = extractConversationIdFromSessionKey(sessionKey);
      console.log('[kilo-chat:approval] prepareTarget conversationId:', conversationId ?? '(none)');
      if (!conversationId) {
        console.log('[kilo-chat:approval] prepareTarget → null (no conversationId)');
        return null;
      }
      console.log('[kilo-chat:approval] prepareTarget → ok', { conversationId });
      return {
        dedupeKey: conversationId,
        target: { conversationId },
      };
    },

    deliverPending: async ({ preparedTarget, pendingPayload, request }) => {
      console.log('[kilo-chat:approval] deliverPending called', {
        conversationId: preparedTarget.conversationId,
        approvalId: request.id,
        blockCount: pendingPayload.length,
      });
      const client = makeClient();
      try {
        const { messageId } = await client.createMessage({
          conversationId: preparedTarget.conversationId,
          content: pendingPayload,
        });
        console.log('[kilo-chat:approval] deliverPending → ok', { messageId });
        return {
          messageId,
          conversationId: preparedTarget.conversationId,
          approvalId: request.id,
        };
      } catch (err) {
        console.error('[kilo-chat:approval] deliverPending → error', err);
        throw err;
      }
    },

    updateEntry: async ({ entry, payload }) => {
      const client = makeClient();
      try {
        await client.editMessage({
          conversationId: entry.conversationId,
          messageId: entry.messageId,
          content: payload,
          timestamp: Date.now(),
        });
      } catch (err: unknown) {
        // 409 means the message was already updated (e.g. user resolved via UI
        // while the gateway also resolved). Suppress gracefully.
        if (err instanceof Error && err.message.includes('409')) return;
        throw err;
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createKiloChatApprovalCapability(): ChannelApprovalCapability {
  return createChannelApprovalCapability({
    authorizeActorAction: () => ({ authorized: true }),
    getActionAvailabilityState: () => ({ kind: 'enabled' as const }),

    delivery: {
      shouldSuppressForwardingFallback: ({ target }) => {
        const channel = target.channel;
        const result = channel === 'kilo-chat';
        console.log('[kilo-chat:approval] shouldSuppressForwardingFallback', { channel, result });
        return result;
      },
    },

    native: {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: 'origin' as const,
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
      }),
      resolveOriginTarget: ({ request }) => {
        const sessionKey = request.request?.sessionKey;
        if (!sessionKey) return null;
        const conversationId = extractConversationIdFromSessionKey(sessionKey);
        if (!conversationId) return null;
        return { to: conversationId };
      },
    },

    render: {
      exec: {
        buildPendingPayload: ({ request }) => ({
          text: `Approval requested: ${request.request.command ?? 'unknown command'} (id: ${request.id})`,
        }),
        buildResolvedPayload: ({ resolved }) => ({
          text: `Approval ${resolved.decision}: ${resolved.request?.command ?? 'command'} (id: ${resolved.id})`,
        }),
      },
      plugin: {
        buildPendingPayload: ({ request }) => ({
          text: `Plugin approval requested: ${request.request.title} (id: ${request.id})`,
        }),
        buildResolvedPayload: ({ resolved }) => ({
          text: `Plugin approval ${resolved.decision}: ${resolved.request?.title ?? 'approval'} (id: ${resolved.id})`,
        }),
      },
    },

    nativeRuntime,
  });
}
