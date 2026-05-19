import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';

describe('ConversationDO attachments table', () => {
  it('has an attachments table with expected columns', async () => {
    const id = env.CONVERSATION_DO.idFromName('schema-probe');
    const stub = env.CONVERSATION_DO.get(id);
    const cols = await runInDurableObject(stub, async (_instance: ConversationDO, state) => {
      return [...state.storage.sql.exec(`PRAGMA table_info(attachments);`)];
    });
    const names = (cols as Array<{ name: string }>).map(c => c.name).sort();
    expect(names).toEqual([
      'created_at',
      'filename',
      'id',
      'idempotency_key',
      'message_id',
      'mime_type',
      'r2_key',
      'size',
      'status',
      'uploader_id',
    ]);
  });
});
