import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEmailToLocalOutbox } from '@/lib/email-local-outbox';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

const execFileMock = jest.mocked(execFile);
let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'kilo-email-outbox-'));
});

afterEach(async () => {
  execFileMock.mockReset();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('local email outbox', () => {
  it('writes a self-contained HTML message with visible delivery metadata', async () => {
    const filePath = await writeEmailToLocalOutbox(
      {
        to: 'developer+magic-link@example.com',
        subject: 'Sign in to Kilo Code',
        html: '<html><body><a href="http://localhost:3000/magic-link">Sign in</a></body></html>',
        replyTo: 'reply@example.com',
      },
      temporaryDirectory
    );

    const html = await readFile(filePath, 'utf8');
    const directoryStats = await stat(temporaryDirectory);
    const fileStats = await stat(filePath);
    expect(path.dirname(filePath)).toBe(temporaryDirectory);
    expect(directoryStats.mode & 0o777).toBe(0o700);
    expect(fileStats.mode & 0o777).toBe(0o600);
    expect(html).toContain('Local email capture');
    expect(html).toContain('Intended recipient: developer+magic-link@example.com');
    expect(html).toContain('Subject: Sign in to Kilo Code');
    expect(html).toContain('Reply-To: reply@example.com');
    expect(html).toContain('href="http://localhost:3000/magic-link"');

    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer.exe'
          : process.platform === 'linux'
            ? 'xdg-open'
            : null;
    if (command) {
      expect(execFileMock).toHaveBeenCalledWith(command, [filePath], expect.any(Function));
    } else {
      expect(execFileMock).not.toHaveBeenCalled();
    }
  });

  it('still captures the email when opening the file fails', async () => {
    execFileMock.mockImplementationOnce(() => {
      throw new Error('No desktop available');
    });

    await expect(
      writeEmailToLocalOutbox(
        {
          to: 'developer@example.com',
          subject: 'Local test',
          html: '<p>Body</p>',
        },
        temporaryDirectory
      )
    ).resolves.toEqual(expect.stringMatching(/\.html$/));
  });

  it('escapes metadata before adding it to the captured HTML', async () => {
    const filePath = await writeEmailToLocalOutbox(
      {
        to: '<script>alert(1)</script>@example.com',
        subject: '<img src=x onerror=alert(1)>',
        html: '<p>Body</p>',
      },
      temporaryDirectory
    );

    const html = await readFile(filePath, 'utf8');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;@example.com');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
