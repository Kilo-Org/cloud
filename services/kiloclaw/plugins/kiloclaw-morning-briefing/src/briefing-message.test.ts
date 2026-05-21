import { describe, expect, it } from 'vitest';
import { buildBriefingMessage } from './briefing-message';
import type { BriefingSourceStatus } from './briefing-utils';

const ALL_CONFIGURED: BriefingSourceStatus[] = [
  { source: 'calendar', configured: true, ok: true, summary: '' },
  { source: 'github', configured: true, ok: true, summary: '' },
];

describe('buildBriefingMessage', () => {
  it('opens with a welcome intro and the TL;DR', () => {
    const message = buildBriefingMessage({
      sections: [],
      statuses: ALL_CONFIGURED,
      tldr: '2 events today',
    });
    expect(message).toContain('Welcome to KiloClaw');
    expect(message).toContain('first daily briefing');
    expect(message).toContain('**TL;DR:** 2 events today');
  });

  it('omits the TL;DR line when there are no fragments', () => {
    const message = buildBriefingMessage({
      sections: [],
      statuses: ALL_CONFIGURED,
      tldr: '',
    });
    expect(message).not.toContain('TL;DR');
  });

  it('includes every populated section in one message and skips empty ones', () => {
    const message = buildBriefingMessage({
      sections: [
        { title: '🗓 Calendar', lines: ['- 09:00 Standup'] },
        { title: '📈 Linear', lines: [] },
        { title: '🐙 GitHub', lines: ['- [Issue](https://x/1)'] },
      ],
      statuses: ALL_CONFIGURED,
      tldr: '',
    });
    expect(message).toContain('## 🗓 Calendar\n- 09:00 Standup');
    expect(message).toContain('## 🐙 GitHub\n- [Issue](https://x/1)');
    expect(message).not.toContain('📈 Linear');
  });

  it('appends a Connect more block linking each source to Settings', () => {
    const message = buildBriefingMessage({
      sections: [{ title: '🗓 Calendar', lines: ['- 09:00 Standup'] }],
      statuses: [
        { source: 'calendar', configured: true, ok: true, summary: '' },
        { source: 'linear', configured: false, ok: false, summary: '' },
        { source: 'github', configured: false, ok: false, summary: '' },
      ],
      tldr: '',
    });
    expect(message).toContain('## ⚙️ Connect more');
    expect(message).toContain('- [Linear](/claw/settings)');
    expect(message).toContain('- [GitHub](/claw/settings)');
  });

  it('omits the Connect more block when every source is configured', () => {
    const message = buildBriefingMessage({
      sections: [{ title: '🗓 Calendar', lines: ['- 09:00 Standup'] }],
      statuses: ALL_CONFIGURED,
      tldr: '',
    });
    expect(message).not.toContain('Connect more');
  });
});
