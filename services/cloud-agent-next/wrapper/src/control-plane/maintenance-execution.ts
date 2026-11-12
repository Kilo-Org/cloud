import { createServer } from 'node:http';
import {
  watchPrMaintenanceResultSchema,
  type MaintenanceChat,
  type MaintenanceOutcome,
  type WatchPrPublicationEvidence,
} from '../../../src/shared/pr-maintenance.js';
import { createMaintenanceGit, type MaintenanceGitOptions } from './maintenance-git.js';
import { createMaintenanceRebase } from './maintenance-rebase.js';
import type { HarnessActivity } from './harness-activity.js';

export type MaintenanceExecution = ReturnType<typeof createMaintenanceExecution>;

export function createMaintenanceExecution(
  input: MaintenanceGitOptions & {
    chat: MaintenanceChat;
    onPublication?: (outcome: MaintenanceOutcome) => void;
  }
) {
  const commands = createMaintenanceGit(input);
  const rebase = createMaintenanceRebase(input.chat, commands);
  const abort = new AbortController();
  const texts = new Map<string, { messageId: string; text: string }>();
  const assistants = new Map<string, string>();
  const receivedMessages = new Set<string>();
  let activeUserMessageId: string | undefined;
  let publication: WatchPrPublicationEvidence = {
    status: 'not_attempted',
    reason: 'No Git publication command was observed.',
  };
  let observedHeadSha: string | undefined;
  let latestMessageId = '';
  let publicationMessageId: string | undefined;
  let published: Promise<WatchPrPublicationEvidence> | undefined;
  let preparing: Promise<string> | undefined;
  let terminal: Promise<void> | undefined;
  let rebaseOperation: Promise<unknown> | undefined;
  let preparationReason: string | undefined;
  const server = createServer((request, response) => {
    const publicationPrefix = `/publish/${input.chat.attemptId}/`;
    const requestedMessageId = request.url?.startsWith(publicationPrefix)
      ? request.url.slice(publicationPrefix.length)
      : request.url === `/publish/${input.chat.attemptId}` && receivedMessages.size === 1
        ? [...receivedMessages][0]
        : undefined;
    const rebaseAction =
      request.url === `/rebase/${input.chat.attemptId}/start`
        ? 'start'
        : request.url === `/rebase/${input.chat.attemptId}/continue`
          ? 'continue'
          : request.url === `/rebase/${input.chat.attemptId}/inspect`
            ? 'inspect'
            : undefined;
    if (
      request.method !== 'POST' ||
      ((requestedMessageId === undefined || !receivedMessages.has(requestedMessageId)) &&
        rebaseAction === undefined)
    ) {
      response.writeHead(404).end();
      return;
    }
    if (abort.signal.aborted || terminal) {
      response.writeHead(409).end(JSON.stringify({ error: 'maintenance_publication_unavailable' }));
      return;
    }
    if (rebaseAction) {
      if (rebaseOperation) {
        response.writeHead(409).end(JSON.stringify({ error: 'maintenance_rebase_busy' }));
        return;
      }
      rebaseOperation =
        rebaseAction === 'start'
          ? rebase.start(abort.signal)
          : rebaseAction === 'continue'
            ? rebase.continueRebase(abort.signal)
            : rebase.inspectConflict(abort.signal);
      void rebaseOperation
        .then(result => {
          response
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify(result));
        })
        .catch(error =>
          response.writeHead(409).end(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'maintenance_rebase_failed',
            })
          )
        )
        .finally(() => {
          rebaseOperation = undefined;
        });
      return;
    }
    if (!observedHeadSha) {
      response
        .writeHead(409)
        .end(JSON.stringify({ error: preparationReason ?? 'maintenance_remote_head_unobserved' }));
      return;
    }
    if (!published) {
      publicationMessageId = requestedMessageId;
      const observed = observedHeadSha;
      published = rebase
        .publicationEvidence()
        .then(evidence =>
          commands.publish(input.chat.publication, observed, abort.signal, evidence)
        )
        .catch((error): WatchPrPublicationEvidence => ({
          status: 'failed',
          reason:
            error instanceof Error
              ? error.message
              : 'maintenance_rebase_publication_proof_unavailable',
        }))
        .then(result => {
          publication = result;
          input.onPublication?.({
            attemptId: input.chat.attemptId,
            messageId: publicationMessageId ?? latestMessageId,
            publication: result,
            result: null,
          });
          return result;
        });
    }
    void published
      .then(result => {
        response.writeHead(result.status === 'published' ? 200 : 409, {
          'Content-Type': 'application/json',
        });
        response.end(JSON.stringify(result));
      })
      .catch(() => response.writeHead(500).end());
  });

  async function prepare(): Promise<string> {
    try {
      await rebase.recover();
      observedHeadSha = await commands.observe(input.chat.publication, abort.signal);
    } catch (error) {
      preparationReason =
        error instanceof Error ? error.message : 'maintenance_publication_preflight_unavailable';
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('maintenance_publication_endpoint_unavailable');
    return [
      'Runtime maintenance instructions:',
      `Use the PR checkout at ${JSON.stringify(input.directory)} for all Git commands.`,
      observedHeadSha
        ? `The current remote PR head observed by Git is ${observedHeadSha}. Fetch and incorporate this work before editing.`
        : `Publication is unavailable (${preparationReason}). Discussion can continue. Do not edit or publish without a fresh maintenance assessment.`,
      'Other chats can edit this checkout. Commit only files you changed. Do not stash, reset, or commit other edits.',
      input.chat.allowRebase === true
        ? `Before editing this batch, run curl --fail-with-body --silent --show-error -X POST http://127.0.0.1:${address.port}/rebase/${input.chat.attemptId}/start . It fetches the target, checks the actual Git conflict, refuses dirty checkouts, and rebases only a confirmed conflict. If not_needed, continue the other repairs. Resolve and stage only your files, then call the same URL with /continue instead of /start until complete. Do not run rebase directly or remove its ownership marker.`
        : `Conflict repairs are disabled. Before editing, check Git state with curl --fail-with-body --silent --show-error -X POST http://127.0.0.1:${address.port}/rebase/${input.chat.attemptId}/inspect . Do not rebase. Report any conflict separately from the authorized review or check repairs.`,
      'Never claim or abort another attempt or user rebase. Rebase only for a Git-confirmed conflict.',
      `To publish after verification, run: curl --fail-with-body --silent --show-error -X POST http://127.0.0.1:${address.port}/publish/${input.chat.attemptId}/__KILO_MAINTENANCE_MESSAGE__`,
      'This command runs git push with the exact observed lease and verifies the remote head. Do not push directly.',
      'A failed lease requires a new assessment. Do not force-push or retry with a weaker lease.',
      'Finish with a single JSON object matching WatchPrMaintenanceResult version 1. Include summary, changedFiles, verification, problems, needsInput.',
      'Include publication:{"status":"not_attempted","reason":"Runtime records publication evidence."}; the runtime replaces it with observed Git evidence.',
      'Ask the user in this chat when a decision is needed. Do not read PR comments, checks, or runs with gh.',
    ].join('\n');
  }

  async function terminate() {
    abort.abort(new Error('maintenance_turn_terminal'));
    if (preparing) await preparing.catch(() => undefined);
    if (published) await published;
    if (rebaseOperation) await rebaseOperation.catch(() => undefined);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await commands.abortOwnedRebase(input.chat.attemptId);
  }

  return {
    async prompt(messageId: string, prompt: string) {
      latestMessageId = messageId;
      receivedMessages.add(messageId);
      while (receivedMessages.size > 32)
        receivedMessages.delete(receivedMessages.keys().next().value ?? '');
      preparing ??= prepare();
      return `${prompt}\n\n${(await preparing).replaceAll('__KILO_MAINTENANCE_MESSAGE__', messageId)}`;
    },
    observe(activity: HarnessActivity) {
      if (activity.type === 'message') {
        const message = activity.message;
        if (message.role === 'user' && receivedMessages.has(message.id))
          activeUserMessageId = message.id;
        if (message.role === 'assistant' && !assistants.has(message.id)) {
          const parent =
            message.parentMessageId ??
            activeUserMessageId ??
            (receivedMessages.size === 1 ? latestMessageId : undefined);
          if (parent && receivedMessages.has(parent)) assistants.set(message.id, parent);
        }
        return;
      }
      const messageId = activity.type === 'part' ? activity.part.messageId : activity.messageId;
      const parentMessageId = assistants.get(messageId);
      if (!parentMessageId) return;
      if (activity.type === 'part' && activity.part.kind === 'text')
        texts.set(activity.part.id, {
          messageId: parentMessageId,
          text: (activity.part.text ?? '').slice(-131_072),
        });
      if (activity.type === 'delta')
        texts.set(activity.partId, {
          messageId: parentMessageId,
          text: `${texts.get(activity.partId)?.text ?? ''}${activity.text}`.slice(-131_072),
        });
      while (texts.size > 4) texts.delete(texts.keys().next().value ?? '');
      while (assistants.size > 32) assistants.delete(assistants.keys().next().value ?? '');
    },
    async finish(messageId: string): Promise<MaintenanceOutcome> {
      terminal ??= terminate();
      await terminal;
      const evidence =
        publicationMessageId === messageId || publicationMessageId === undefined
          ? publication
          : {
              status: 'not_attempted' as const,
              reason: 'Publication is retained on its original message.',
            };
      const workspace = await commands.snapshot(input.chat.publication);
      let result: MaintenanceOutcome['result'] = null;
      let resultMessageId: string | undefined;
      for (const text of [...texts.values()].reverse()) {
        try {
          const value: unknown = JSON.parse(
            text.text
              .trim()
              .replace(/^```(?:json)?\s*\n?/, '')
              .replace(/\n?```$/, '')
          );
          if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
          const parsed = watchPrMaintenanceResultSchema.safeParse({
            ...value,
            publication: evidence,
          });
          if (parsed.success) {
            result = parsed.data;
            resultMessageId = text.messageId;
            break;
          }
        } catch {
          continue;
        }
      }
      return {
        attemptId: input.chat.attemptId,
        messageId,
        publication: evidence,
        result,
        workspace,
        ...(resultMessageId ? { resultMessageId } : {}),
      };
    },
    async cleanup() {
      terminal ??= terminate();
      await terminal;
    },
  };
}
