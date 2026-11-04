import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createSlackAttachmentUrlFetcher, isSlackFileUrl } from './slack-attachment-fetcher';

const BOT_TOKEN = 'test-slack-token';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isSlackFileUrl', () => {
  it('accepts only https file URLs on Slack hosts', () => {
    expect(isSlackFileUrl('https://files.slack.com/files-pri/T1-F1/report.pdf')).toBe(true);
    expect(isSlackFileUrl('https://acme.slack.com/files-pri/T1-F1/report.pdf')).toBe(true);

    expect(isSlackFileUrl('http://files.slack.com/files-pri/T1-F1/report.pdf')).toBe(false);
    expect(isSlackFileUrl('https://files.example.com/report.pdf')).toBe(false);
    expect(isSlackFileUrl('https://slack.com.example.com/report.pdf')).toBe(false);
    expect(isSlackFileUrl('not a url')).toBe(false);
  });
});

describe('createSlackAttachmentUrlFetcher', () => {
  it('sends the installation token to a Slack file URL', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('body', { status: 200 }));

    const response = await createSlackAttachmentUrlFetcher(BOT_TOKEN)(
      'https://files.slack.com/files-pri/T1-F1/notes.txt'
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://files.slack.com/files-pri/T1-F1/notes.txt',
      expect.objectContaining({ headers: { Authorization: `Bearer ${BOT_TOKEN}` } })
    );
  });

  it('refuses to authorize a URL outside the Slack file hosts', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    await expect(
      createSlackAttachmentUrlFetcher(BOT_TOKEN)('https://files.example.com/notes.txt')
    ).rejects.toThrow('outside the Slack file hosts');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
