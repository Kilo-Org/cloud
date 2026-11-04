import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { CONTAINERS_INTERCEPT_CA_PATH } from '../../../src/shared/container-intercept.js';

const existsSync = fs.existsSync;

await mock.module('node:fs', () => ({
  ...fs,
  existsSync: (path: Parameters<typeof existsSync>[0]) =>
    path !== CONTAINERS_INTERCEPT_CA_PATH && existsSync(path),
}));
