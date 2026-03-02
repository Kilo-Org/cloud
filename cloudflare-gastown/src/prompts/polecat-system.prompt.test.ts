import { describe, it, expect } from 'vitest';
import { buildPolecatSystemPrompt } from './polecat-system.prompt';

describe('buildPolecatSystemPrompt', () => {
  const params = {
    agentName: 'polly',
    rigId: 'rig-123',
    townId: 'town-abc',
    identity: 'polecat-alpha',
  };

  it('should include agent name and identity', () => {
    const prompt = buildPolecatSystemPrompt(params);
    expect(prompt).toContain('polly');
    expect(prompt).toContain('polecat-alpha');
  });

  it('should include rig and town IDs', () => {
    const prompt = buildPolecatSystemPrompt(params);
    expect(prompt).toContain('rig-123');
    expect(prompt).toContain('town-abc');
  });

  it('should include GUPP principle', () => {
    const prompt = buildPolecatSystemPrompt(params);
    expect(prompt).toContain('GUPP');
    expect(prompt).toContain('execute immediately');
  });

  it('should list all 8 gastown tools', () => {
    const prompt = buildPolecatSystemPrompt(params);
    expect(prompt).toContain('gt_prime');
    expect(prompt).toContain('gt_bead_status');
    expect(prompt).toContain('gt_bead_close');
    expect(prompt).toContain('gt_done');
    expect(prompt).toContain('gt_mail_send');
    expect(prompt).toContain('gt_mail_check');
    expect(prompt).toContain('gt_escalate');
    expect(prompt).toContain('gt_checkpoint');
  });

  it('should include commit/push hygiene instructions', () => {
    const prompt = buildPolecatSystemPrompt(params);
    expect(prompt).toContain('Push after every commit');
    expect(prompt).toContain('ephemeral');
  });

  it('should include escalation protocol', () => {
    const prompt = buildPolecatSystemPrompt(params);
    expect(prompt).toContain('gt_escalate');
    expect(prompt).toContain('stuck');
  });
});
