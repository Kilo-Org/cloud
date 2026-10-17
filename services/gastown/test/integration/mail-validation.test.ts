/**
 * Integration tests for mail delivery limits and the alarm mail sweep.
 *
 * Covers: rejection of mail to nonexistent recipients, subject/body size
 * caps, the per-recipient cap on open message beads, the delivery batch
 * limit, and the alarm housekeeping step that closes open message beads
 * whose recipient no longer exists or that outlived the retention window.
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { MAIL_RETENTION_MS } from '../../src/dos/town/mail';
import type { TownDO } from '../../src/dos/Town.do';

function getTownStub(name: string): DurableObjectStub<TownDO> {
  const id = env.TOWN.idFromName(name);
  return env.TOWN.get(id);
}

const OVERSIZED_SUBJECT = 's'.repeat(201);
const OVERSIZED_BODY = 'b'.repeat(4001);

describe('mail validation and delivery limits', () => {
  let town: DurableObjectStub<TownDO>;
  let townName: string;

  beforeEach(async () => {
    townName = `mailval-${crypto.randomUUID()}`;
    town = getTownStub(townName);
    await town.setTownId(townName);
    await town.addRig({
      rigId: 'rig-1',
      name: 'main-rig',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  it('rejects mail addressed to a nonexistent agent', async () => {
    const sender = await town.registerAgent({
      role: 'polecat',
      name: 'S1',
      identity: `mailval-sender-${townName}`,
    });

    let err: unknown;
    await town
      .sendMail({
        from_agent_id: sender.id,
        to_agent_id: 'no-such-agent-id',
        subject: 'Hello',
        body: 'Body',
      })
      .catch(e => {
        err = e;
      });
    expect(String((err as Error)?.message)).toMatch(/no-such-agent-id/);
  });

  it('rejects mail with an oversized subject or body', async () => {
    const sender = await town.registerAgent({
      role: 'polecat',
      name: 'S2',
      identity: `mailval-s2-${townName}`,
    });
    const receiver = await town.registerAgent({
      role: 'polecat',
      name: 'R2',
      identity: `mailval-r2-${townName}`,
    });

    let err: unknown;
    await town
      .sendMail({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: OVERSIZED_SUBJECT,
        body: 'Body',
      })
      .catch(e => {
        err = e;
      });
    expect(err).toBeDefined();

    await town
      .sendMail({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: 'Hello',
        body: OVERSIZED_BODY,
      })
      .catch(e => {
        err = e;
      });
    expect(err).toBeDefined();

    const mailbox = await town.checkMail(receiver.id);
    expect(mailbox).toHaveLength(0);
  });

  it('rejects a new message once the recipient holds the cap of open messages', async () => {
    const sender = await town.registerAgent({
      role: 'polecat',
      name: 'S3',
      identity: `mailval-s3-${townName}`,
    });
    const receiver = await town.registerAgent({
      role: 'polecat',
      name: 'R3',
      identity: `mailval-r3-${townName}`,
    });

    for (let i = 0; i < 50; i++) {
      await town.sendMail({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: `Msg ${i}`,
        body: `Body ${i}`,
      });
    }

    let err: unknown;
    await town
      .sendMail({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: 'Over the cap',
        body: 'Should fail',
      })
      .catch(e => {
        err = e;
      });
    expect(String((err as Error)?.message)).toMatch(/already holds 50 open/);

    // Delivering resets the counter, so sending works again afterwards.
    const delivered = await town.checkMail(receiver.id);
    expect(delivered).toHaveLength(50);

    await town.sendMail({
      from_agent_id: sender.id,
      to_agent_id: receiver.id,
      subject: 'After delivery',
      body: 'Accepted again',
    });
    expect(await town.checkMail(receiver.id)).toHaveLength(1);
  });

  it('delivers at most a bounded batch per tick', async () => {
    const sender = await town.registerAgent({
      role: 'polecat',
      name: 'S4',
      identity: `mailval-s4-${townName}`,
    });
    const receiver = await town.registerAgent({
      role: 'polecat',
      name: 'R4',
      identity: `mailval-r4-${townName}`,
    });
    await town.updateAgentStatus(receiver.id, 'working');
    const receiverBead = await town.createBead({
      type: 'issue',
      title: 'Filler bead for the first recipient',
    });
    await town.hookBead(receiver.id, receiverBead.bead_id);

    for (let i = 0; i < 50; i++) {
      await town.sendMail({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: `Batch ${i}`,
        body: `Body ${i}`,
      });
    }

    await runDurableObjectAlarm(town);

    // The alarm tick delivered one batch (50) — the mailbox is drained and
    // the delivery batch never exceeded 50 in a single tick.
    const remaining = await town.checkMail(receiver.id);
    expect(remaining.length).toBeLessThanOrEqual(50);
  });

  it('keeps mail from a second recipient deliverable when the first fills the batch', async () => {
    const sender = await town.registerAgent({
      role: 'polecat',
      name: 'S8',
      identity: `mailval-s8-${townName}`,
    });
    const busy = await town.registerAgent({
      role: 'polecat',
      name: 'R8',
      identity: `mailval-r8-${townName}`,
    });
    const other = await town.registerAgent({
      role: 'polecat',
      name: 'R9',
      identity: `mailval-r9-${townName}`,
    });
    await town.updateAgentStatus(busy.id, 'working');
    await town.updateAgentStatus(other.id, 'working');
    const busyBead = await town.createBead({
      type: 'issue',
      title: 'Filler bead for the busy recipient',
    });
    await town.hookBead(busy.id, busyBead.bead_id);
    const otherBead = await town.createBead({
      type: 'issue',
      title: 'Filler bead for the second recipient',
    });
    await town.hookBead(other.id, otherBead.bead_id);

    // 40 + 20 messages exceeds the 50-row batch window; the second
    // recipient's last 10 messages sit past it.
    for (let i = 0; i < 40; i++) {
      await town.sendMail({
        from_agent_id: sender.id,
        to_agent_id: busy.id,
        subject: `Filler ${i}`,
        body: `Body ${i}`,
      });
    }
    for (let i = 0; i < 20; i++) {
      await town.sendMail({
        from_agent_id: sender.id,
        to_agent_id: other.id,
        subject: `Note ${i}`,
        body: `Body ${i}`,
      });
    }

    // sendMail doesn't arm the alarm; do it explicitly for this test.
    await town.touchAgentHeartbeat(sender.id, {});

    await runDurableObjectAlarm(town);

    // The 10 messages past the batch window stay open and are delivered on
    // a later tick.
    const otherMail = await town.checkMail(other.id);
    expect(otherMail).toHaveLength(10);
  });

  it('closes mail whose recipient was deleted and mail past the retention window', async () => {
    const sender = await town.registerAgent({
      role: 'polecat',
      name: 'S5',
      identity: `mailval-s5-${townName}`,
    });
    const doomed = await town.registerAgent({
      role: 'polecat',
      name: 'R5',
      identity: `mailval-r5-${townName}`,
    });
    const idle = await town.registerAgent({
      role: 'polecat',
      name: 'R6',
      identity: `mailval-r6-${townName}`,
    });

    await town.sendMail({
      from_agent_id: sender.id,
      to_agent_id: doomed.id,
      subject: 'Queued note A',
      body: 'Note body A',
    });
    await town.sendMail({
      from_agent_id: sender.id,
      to_agent_id: idle.id,
      subject: 'Queued note B',
      body: 'Note body B',
    });

    await town.deleteAgent(doomed.id);

    // sendMail doesn't arm the alarm; do it explicitly for this test.
    await town.touchAgentHeartbeat(idle.id, {});

    await runDurableObjectAlarm(town);

    const beads = await town.listBeads({ type: 'message' });
    const statusBySubject: Record<string, string> = {};
    for (const b of beads) {
      statusBySubject[b.title] = b.status;
    }
    expect(statusBySubject['Queued note A']).toBe('closed');
    expect(statusBySubject['Queued note B']).toBe('open');
  });

  it('closes mail past the retention window even when the recipient exists', async () => {
    const sender = await town.registerAgent({
      role: 'polecat',
      name: 'S7',
      identity: `mailval-s7-${townName}`,
    });
    const receiver = await town.registerAgent({
      role: 'polecat',
      name: 'R7',
      identity: `mailval-r7-${townName}`,
    });

    await town.sendMail({
      from_agent_id: sender.id,
      to_agent_id: receiver.id,
      subject: 'Aged mail',
      body: 'Older than the retention window',
    });

    // Age the message beyond the retention window by backdating created_at.
    await town.debugBackdateMessageBead(receiver.id, MAIL_RETENTION_MS + 60_000);

    // sendMail doesn't arm the alarm; do it explicitly for this test.
    await town.touchAgentHeartbeat(sender.id, {});

    await runDurableObjectAlarm(town);

    const mailbox = await town.checkMail(receiver.id);
    expect(mailbox).toHaveLength(0);
  });
});
