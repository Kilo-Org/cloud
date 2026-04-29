import { createChannelApprovalCapability } from 'openclaw/plugin-sdk/approval-delivery-runtime';
import type { ChannelApprovalCapability } from 'openclaw/plugin-sdk/channel-contract';
import type {
  ChannelApprovalNativeRuntimeAdapter,
  PendingApprovalView,
  ResolvedApprovalView,
  ExpiredApprovalView,
} from 'openclaw/plugin-sdk/approval-handler-runtime';
import type { z } from 'zod';
import type { actionsBlockSchema, contentBlockSchema } from './synced/schemas.js';

type ContentBlock = z.infer<typeof contentBlockSchema>;
type ActionsBlock = z.infer<typeof actionsBlockSchema>;
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
  // The kilo-chat frontend renders text with react-markdown, so we need
  // double newlines for paragraph breaks and trailing double-space for
  // line breaks within a section.
  const sections: string[] = [];
  sections.push(`**${view.title}**`);
  if (view.description) sections.push(view.description);
  // Show the command being approved for exec approvals.
  if (view.approvalKind === 'exec') {
    sections.push(`\`\`\`\n${view.commandText}\n\`\`\``);
    if (view.commandPreview && view.commandPreview !== view.commandText) {
      sections.push(`_${view.commandPreview}_`);
    }
  }
  if (view.metadata.length > 0) {
    // Trailing double-space forces a <br> in markdown for each metadata line.
    const metaLines = view.metadata.map(m => `**${m.label}:** ${m.value}`);
    sections.push(metaLines.join('  \n'));
  }
  return sections.join('\n\n');
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
  // Actions must have at least one entry per the schema; for resolved blocks
  // we carry through a zero-action placeholder describing the resolution.
  const actionsBlock = {
    type: 'actions' as const,
    groupId: view.approvalId,
    actions: [],
    resolved: {
      value: view.decision,
      resolvedBy,
      resolvedAt: Date.now(),
    },
  } satisfies ActionsBlock;
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
    isConfigured: () => true,
    shouldHandle: () => true,
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
      if (!sessionKey) return null;
      const conversationId = extractConversationIdFromSessionKey(sessionKey);
      if (!conversationId) return null;
      return {
        dedupeKey: conversationId,
        target: { conversationId },
      };
    },

    deliverPending: async ({ preparedTarget, pendingPayload, request }) => {
      const client = makeClient();
      const { messageId } = await client.createMessage({
        conversationId: preparedTarget.conversationId,
        content: pendingPayload,
      });
      return {
        messageId,
        conversationId: preparedTarget.conversationId,
        approvalId: request.id,
      };
    },

    updateEntry: async ({ entry, payload }) => {
      const client = makeClient();
      const result = await client.editMessage({
        conversationId: entry.conversationId,
        messageId: entry.messageId,
        content: payload,
        timestamp: Date.now(),
      });
      // stale means the message was already updated (e.g. user resolved via UI
      // while the gateway also resolved). Suppress gracefully.
      if (result.stale) return;
    },
  },
};

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createKiloChatApprovalCapability(): ChannelApprovalCapability {
  return createChannelApprovalCapability({
    // Authorization is enforced by the kilo-chat Worker's execute-action
    // endpoint: callerId is derived from the JWT and the DO checks membership.
    // This callback is intentionally permissive because the Worker is the trust
    // boundary.
    //
    // IMPORTANT: the Worker currently checks *membership*, not *session
    // ownership*. If multi-party conversations ship (additionalMembers), any
    // member could approve exec actions running on the conversation-owner's Fly
    // machine. Gate on session ownership before enabling multi-party.
    authorizeActorAction: () => ({ authorized: true }),
    getActionAvailabilityState: () => ({ kind: 'enabled' as const }),

    delivery: {
      shouldSuppressForwardingFallback: ({ target }) => target.channel === 'kilo-chat',
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
