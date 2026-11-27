import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Self-referencing symbol: miniflare resolves this to the current (runner) worker,
// letting the destroy-sandbox test call the RPC method on our own entrypoint.
const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        // Point the KILOCLAW service binding at the stub worker below.
        // It must be a named worker reference (not a plain Response function)
        // because the queue handler calls KILOCLAW.deliverChatWebhook() via
        // RPC, which requires a WorkerEntrypoint — plain HTTP stubs don't
        // support RPC and cause intermittent workerd "Failed to get handler
        // to worker" errors.
        serviceBindings: {
          KILOCLAW: 'kiloclaw-stub',
          EVENT_SERVICE: 'event-service-stub',
          NOTIFICATIONS: 'notifications-stub',
          KILO_CHAT_SELF: kCurrentWorker,
          // Worker unit tests resolve the STS binding to the stub below instead of the deployed
          // broker. The binding names the `SecretsBroker` entrypoint, so the stub exports it.
          // Nothing reaches it while SECRETS_SOURCE is `env`.
          STS: 'sts-stub',
        },
        workers: [
          {
            name: 'sts-stub',
            modules: true,
            script: `
              import { WorkerEntrypoint } from 'cloudflare:workers';
              export class SecretsBroker extends WorkerEntrypoint {
                async getBundle() {
                  return { status: 'unavailable', reason: 'internal', retryAfterSeconds: 5 };
                }
              }
              export default class StsStub extends WorkerEntrypoint {
                async fetch() { return new Response('ok'); }
              }
            `,
          },
          {
            name: 'kiloclaw-stub',
            modules: true,
            script: `
              import { WorkerEntrypoint } from 'cloudflare:workers';
              // Recorded calls are kept in module scope so both the stub and
              // tests (via service-binding RPC) see the same array.
              const recorded = [];
              export default class KiloclawStub extends WorkerEntrypoint {
                async deliverChatWebhook(payload) {
                  recorded.push(payload);
                }
                async __recordedWebhookCalls() {
                  return recorded.slice();
                }
                async __clearWebhookCalls() {
                  recorded.length = 0;
                }
              }
            `,
          },
          {
            name: 'event-service-stub',
            modules: true,
            script: `
              import { WorkerEntrypoint } from 'cloudflare:workers';
              export default class EventServiceStub extends WorkerEntrypoint {
                async fetch(request) {
                  return new Response('ok');
                }
                async pushEvent(userId, context, event, payload) {
                  return false;
                }
              }
            `,
          },
          {
            name: 'notifications-stub',
            modules: true,
            script: `
              import { WorkerEntrypoint } from 'cloudflare:workers';
              const bucketsByUser = new Map();
              const bucketKey = ({ userId, badgeBucket }) => \`\${userId}:\${badgeBucket}\`;
              const listForUser = userId =>
                Array.from(bucketsByUser.entries())
                  .filter(([key, badgeCount]) => key.startsWith(\`\${userId}:\`) && badgeCount > 0)
                  .map(([key, badgeCount]) => ({
                    badgeBucket: key.slice(userId.length + 1),
                    badgeCount,
                  }));
              export default class NotificationsStub extends WorkerEntrypoint {
                async fetch(request) {
                  return new Response('ok');
                }
                async clearBadgeBucketForUser(input) {
                  const key = bucketKey(input);
                  bucketsByUser.delete(key);
                  const badgeCount = listForUser(input.userId).reduce(
                    (total, bucket) => total + bucket.badgeCount,
                    0
                  );
                  return { badgeCount };
                }
                async __incrementBadgeBucket(input) {
                  const key = bucketKey(input);
                  bucketsByUser.set(key, (bucketsByUser.get(key) ?? 0) + input.delta);
                }
                async __listNonZeroBuckets(userId) {
                  return listForUser(userId);
                }
              }
            `,
          },
        ],
      },
    }),
  ],
  test: {
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
