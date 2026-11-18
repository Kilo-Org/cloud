import { expect } from '@jest/globals';
import { dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifyApproval(actual: string, approvalFilePath: string): Promise<void> {
  await mkdir(dirname(approvalFilePath), { recursive: true });

  try {
    const expected = await readFile(approvalFilePath, 'utf-8');
    expect(actual).toBe(expected);
  } catch (e) {
    await writeFile(approvalFilePath, actual);
    throw e;
  }
}
