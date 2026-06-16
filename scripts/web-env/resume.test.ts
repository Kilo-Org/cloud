import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readResumeJournal, writeResumeJournal, type ResumeJournal } from './resume.js';

void test('resume journals are value-free, private, and round-trip safely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-env-resume-test-'));
  try {
    const journal: ResumeJournal = {
      version: 1,
      variableName: 'API_TOKEN',
      sensitive: true,
      createdAt: '2026-06-16T12:00:00.000Z',
      completed: ['kilocode-app/development'],
      failed: 'kilocode-global-app/development',
      pending: ['kilocode-app/staging'],
      onePassword: 'pending',
    };
    const relativePath = await writeResumeJournal(root, journal);
    const absolutePath = path.join(root, relativePath);
    const content = await readFile(absolutePath, 'utf8');
    assert.equal(content.includes('super-secret-value'), false);
    assert.deepEqual(await readResumeJournal(absolutePath), journal);
    assert.equal((await stat(absolutePath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
