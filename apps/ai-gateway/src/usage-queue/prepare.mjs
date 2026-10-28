import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStagingDeployment } from './deployment.mjs';

const callback = new URL('../app/api/v1/internal/queues/usage/route.ts', import.meta.url);
if (isStagingDeployment(process.env)) {
  await mkdir(dirname(fileURLToPath(callback)), { recursive: true });
  await copyFile(new URL('./route.ts', import.meta.url), callback);
} else {
  // Remove a previous staging build's generated file before a production build.
  await rm(callback, { force: true });
}
