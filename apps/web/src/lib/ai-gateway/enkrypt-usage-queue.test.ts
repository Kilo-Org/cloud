import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { enkrypt_usage } from '@kilocode/db/schema';
import {
  ENKRYPT_USAGE_WRITE_PATH,
  EnkryptUsageQueueMessageSchema,
  EnkryptUsageWriteSchema,
  type EnkryptUsageQueueMessage,
} from '@kilocode/usage-contracts';

jest.mock('next/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: jest.fn(() => false),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  ENKRYPT_USAGE_QUEUE_ENABLED: true,
  USAGE_INGEST_URL: 'https://ingest.synthetic.invalid/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-publish-secret',
}));

import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db, isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import {
  MICRODOLLARS_PER_ENKRYPT_CREDIT,
  recordEnkryptUsage,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  enkryptUsageRecordForNewOrganization,
  organizationMicrodollarsUsed,
} from '@kilocode/web-shared/tests/helpers/enkrypt-usage.helper';
import { POST as writeEnkryptUsageRoute } from '@/app/api/internal/enkrypt-usage/record/route';

const INGEST_URL = 'https://ingest.synthetic.invalid/enkrypt-usage';
const WRITER_ORIGIN = 'https://app.synthetic.invalid';
const ENKRYPT_WRITER_URL = `${WRITER_ORIGIN}${ENKRYPT_USAGE_WRITE_PATH}`;

type QueueMessage = {
  id: string;
  timestamp: Date;
  body: unknown;
  attempts: number;
  ack: jest.Mock;
  retry: jest.Mock;
};

// Load the actual Worker handlers without importing their runtime globals into the Next.js typecheck.
const { handleFetch } = jest.requireActual<{
  handleFetch: (
    request: Request,
    env: {
      USAGE_INGEST_PUBLISH_SECRET: string;
      USAGE_INGEST_QUEUE: { send: (message: unknown) => Promise<void> };
    }
  ) => Promise<Response>;
}>('../../../../../services/usage-ingest/src/publish-usage');
const { handleQueue } = jest.requireActual<{
  handleQueue: (
    batch: { queue: string; messages: QueueMessage[]; ackAll: jest.Mock; retryAll: jest.Mock },
    env: { USAGE_WRITER_URL: string; USAGE_WRITER_SECRET: string | undefined }
  ) => Promise<void>;
}>('../../../../../services/usage-ingest/src/consume-usage');

const mockedIsUSRegion = jest.mocked(isUSRegion);
const queued: unknown[] = [];
const requestedUrls: string[] = [];

async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  requestedUrls.push(url);
  if (url === INGEST_URL) {
    return handleFetch(new Request(url, init), {
      USAGE_INGEST_PUBLISH_SECRET: 'synthetic-publish-secret',
      USAGE_INGEST_QUEUE: {
        send: async message => {
          queued.push(message);
        },
      },
    });
  }
  if (url === ENKRYPT_WRITER_URL) {
    return writeEnkryptUsageRoute(new NextRequest(new Request(url, init)));
  }
  throw new TypeError('unexpected fetch target');
}

beforeEach(() => {
  queued.length = 0;
  requestedUrls.length = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation(routeFetch);
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  mockedIsUSRegion.mockReturnValue(false);
  jest.restoreAllMocks();
});

describe('Enkrypt usage from the gateway through the usage queue', () => {
  it.each([
    ['Frankfurt', false],
    ['SFO', true],
  ])(
    'records the same write from %s through the ingress, queue and consumer',
    async (_region, us) => {
      mockedIsUSRegion.mockReturnValue(us);
      const usageRecord = await enkryptUsageRecordForNewOrganization();

      await recordEnkryptUsage(usageRecord);

      expect(requestedUrls).toEqual([INGEST_URL]);
      expect(queued).toHaveLength(1);
      const message: EnkryptUsageQueueMessage = EnkryptUsageQueueMessageSchema.parse(queued[0]);
      expect(message.record).toEqual(
        EnkryptUsageWriteSchema.parse({
          ...usageRecord,
          id: message.record.id,
          occurredAt: message.record.occurredAt,
        })
      );
      expect(await organizationMicrodollarsUsed(usageRecord.organizationId)).toBe(0);

      const delivery: QueueMessage = {
        id: 'synthetic-queue-message',
        timestamp: new Date(),
        body: queued[0],
        attempts: 1,
        ack: jest.fn(),
        retry: jest.fn(),
      };
      await handleQueue(
        {
          queue: 'usage-ingest-processing-eu',
          messages: [delivery],
          ackAll: jest.fn(),
          retryAll: jest.fn(),
        },
        {
          USAGE_WRITER_URL: `${WRITER_ORIGIN}/api/internal/usage/record`,
          USAGE_WRITER_SECRET: INTERNAL_API_SECRET,
        }
      );

      expect(requestedUrls).toEqual([INGEST_URL, ENKRYPT_WRITER_URL]);
      expect(delivery.ack).toHaveBeenCalledTimes(1);
      expect(delivery.retry).not.toHaveBeenCalled();
      const rows = await db
        .select({ id: enkrypt_usage.id, createdAt: enkrypt_usage.created_at })
        .from(enkrypt_usage)
        .where(eq(enkrypt_usage.organization_id, usageRecord.organizationId));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(message.record.id);
      expect(new Date(rows[0].createdAt).toISOString()).toBe(message.record.occurredAt);
      expect(await organizationMicrodollarsUsed(usageRecord.organizationId)).toBe(
        7 * MICRODOLLARS_PER_ENKRYPT_CREDIT
      );
    }
  );
});
