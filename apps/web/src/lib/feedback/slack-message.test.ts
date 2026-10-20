import { describe, expect, it } from '@jest/globals';

import { SLACK_TRUNCATION_MARKER } from '@/lib/slack/slack-escape';
import {
  buildCloudAgentFeedbackSlackMessage,
  buildUserFeedbackSlackMessage,
  type FeedbackSlackMessage,
} from './slack-message';

type SectionText = { kind: 'mrkdwn' | 'plain_text'; text: string };

function sectionTexts(message: FeedbackSlackMessage): SectionText[] {
  return message.blocks.flatMap(block => {
    if (block.type !== 'section' || !('text' in block) || !block.text) return [];
    return [{ kind: block.text.type, text: block.text.text }];
  });
}

function blocksContaining(message: FeedbackSlackMessage, needle: string): SectionText[] {
  return sectionTexts(message).filter(section => section.text.includes(needle));
}

describe('buildUserFeedbackSlackMessage', () => {
  const hostileText =
    '```\n<!channel> ping <@U12345>\n<https://example.test/phish|the docs>\n```';

  it('carries the feedback body only in a plain_text block', () => {
    const message = buildUserFeedbackSlackMessage({
      userId: 'user_1',
      feedbackText: hostileText,
    });

    const holders = blocksContaining(message, 'ping');
    expect(holders).toHaveLength(1);
    expect(holders[0].kind).toBe('plain_text');
    expect(holders[0].text).toBe(`• raw feedback:\n${hostileText.trim()}`);
  });

  it('keeps the notification fallback free of caller text', () => {
    const message = buildUserFeedbackSlackMessage({
      userId: 'user_1',
      feedbackText: hostileText,
      feedbackFor: '<!channel>',
    });

    expect(message.text).toBe('New user feedback');
    expect(message.text).not.toContain('channel');
    expect(message.unfurl_links).toBe(false);
    expect(message.unfurl_media).toBe(false);
  });

  it('escapes and caps the metadata lines', () => {
    const message = buildUserFeedbackSlackMessage({
      userId: 'user_1',
      feedbackFor: '<!channel>',
      source: 'web`source',
      feedbackBatch: `b${'x'.repeat(400)}`,
    });

    const metadata = sectionTexts(message).find(section => section.text.includes('• user:'))!;
    expect(metadata.kind).toBe('mrkdwn');
    expect(metadata.text).toContain('• for: &lt;!channel&gt;');
    expect(metadata.text).toContain("• source: web'source");
    expect(metadata.text).toContain(SLACK_TRUNCATION_MARKER);
    expect(metadata.text).not.toContain('<!channel>');
  });

  it('marks an empty submission', () => {
    const message = buildUserFeedbackSlackMessage({ userId: 'user_1', feedbackText: '   ' });
    expect(blocksContaining(message, '<empty>')).toHaveLength(1);
  });

  it('caps a long body and notes the truncation', () => {
    const message = buildUserFeedbackSlackMessage({
      userId: 'user_1',
      feedbackText: 'a'.repeat(5_000),
    });
    const body = blocksContaining(message, 'a'.repeat(10))[0];
    expect(body.kind).toBe('plain_text');
    expect(body.text.length).toBeLessThanOrEqual(`• raw feedback:\n${'a'.repeat(2_000)}`.length);
    expect(body.text.endsWith(SLACK_TRUNCATION_MARKER)).toBe(true);
  });
});

describe('buildCloudAgentFeedbackSlackMessage', () => {
  const sessionId = 'ses_0123456789abcdef01234567';

  it('links a canonical session id with an encoded target and escaped label', () => {
    const message = buildCloudAgentFeedbackSlackMessage({
      kiloSessionId: sessionId,
      sessionTypeLabel: 'Cloud Agent',
      feedbackText: 'the send button did nothing',
    });

    const metadata = sectionTexts(message).find(section => section.text.includes('• session:'))!;
    expect(metadata.text).toBe(
      `• session: <https://app.kilo.ai/admin/session-traces?sessionId=${sessionId}|${sessionId}>\n• session type: Cloud Agent`
    );
  });

  it('encodes the session id in the link target and keeps it inside one link', () => {
    const message = buildCloudAgentFeedbackSlackMessage({
      kiloSessionId: `ses_${'<>'.repeat(13)}`,
      feedbackText: 'body',
    });

    const metadata = sectionTexts(message).find(section => section.text.includes('• session:'))!;
    const link = metadata.text.split('\n')[0];
    expect(link).toContain(`sessionId=ses_${'%3C%3E'.repeat(13)}`);
    expect(link.match(/<[^<>]*>/g)).toHaveLength(1);
    expect(link).toContain('&lt;&gt;');
  });

  it('renders an unknown session and session type when the caller omitted them', () => {
    const message = buildCloudAgentFeedbackSlackMessage({ feedbackText: 'body' });
    const metadata = sectionTexts(message).find(section => section.text.includes('• session:'))!;
    expect(metadata.text).toBe('• session: _unknown_\n• session type: _unknown_');
  });

  it('escapes the session type label', () => {
    const message = buildCloudAgentFeedbackSlackMessage({
      sessionTypeLabel: '<!here>',
      feedbackText: 'body',
    });
    const metadata = sectionTexts(message).find(section => section.text.includes('• session type:'));
    expect(metadata?.text).toContain('&lt;!here&gt;');
  });

  it('carries the body as plain text and caps it at 500 characters', () => {
    const message = buildCloudAgentFeedbackSlackMessage({
      kiloSessionId: sessionId,
      feedbackText: `${'b'.repeat(600)}\n<!channel>`,
    });

    const body = blocksContaining(message, 'b'.repeat(10))[0];
    expect(body.kind).toBe('plain_text');
    expect(body.text.endsWith(SLACK_TRUNCATION_MARKER)).toBe(true);
    expect(body.text).not.toContain('<!channel>');
    expect(body.text.length).toBeLessThanOrEqual(`• feedback:\n${'b'.repeat(500)}`.length);
    expect(message.text).toBe('New Cloud Agent feedback');
  });
});
