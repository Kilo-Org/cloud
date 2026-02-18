import { getEnvVariable } from '@/lib/dotenvx';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Writable } from 'stream';
import { after } from 'next/server';

export const inStreamDebugMode =
  process.env.NODE_ENV === 'development' && getEnvVariable('DEV_SAVE_PROXY_STREAMS');

const fileSafeIsoDate = () => new Date().toISOString().replace(/[:.]/g, '-');
const debugRequestLogPath = path.join(process.cwd(), 'dev-debug-request-logs');

export function debugSaveLog(requestBodyText: string, logFileExtension: string): void {
  if (!inStreamDebugMode) return;
  const filePath = path.join(debugRequestLogPath, `${fileSafeIsoDate()}.${logFileExtension}`);
  after(saveStringToFile(filePath, requestBodyText));
}

export function debugSaveProxyRequest(requestBodyText: string): void {
  debugSaveLog(requestBodyText, 'log.req.json');
}

export function debugSaveProxyResponseStream(response: Response, logFileExtension: string): void {
  const stream = inStreamDebugMode ? response.clone().body : null;
  if (!stream) return;
  const filePath = path.join(debugRequestLogPath, fileSafeIsoDate() + logFileExtension);
  console.log(`Saving raw stream to ${filePath}`);
  after(saveStreamToFile(filePath, stream));
}

async function saveStringToFile(filePath: string, content: string) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, content);
}

async function saveStreamToFile(filePath: string, stream: ReadableStream) {
  const dirname = path.dirname(filePath);
  await fsPromises.mkdir(dirname, { recursive: true });
  const fileHandle = await fsPromises.open(filePath, 'w');
  const fileStream = fileHandle.createWriteStream();
  const writableStream = Writable.toWeb(fileStream);
  try {
    await stream.pipeTo(writableStream);
  } catch (error) {
    // Handle client abort - the stream was terminated but we saved what we could
    if (error instanceof Error && error.name === 'ResponseAborted') {
      console.log(`Stream aborted while saving to ${filePath} (partial data saved)`);
      return;
    }
    console.error(`Error saving stream to ${filePath}:`, error);
  } finally {
    await fileHandle.close();
  }
}
