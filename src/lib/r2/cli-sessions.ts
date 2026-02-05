import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { r2Client, getR2CliSessionsBucketName } from './client';
import type { CliSession } from '@/db/schema';

export type FolderName = 'sessions' | 'shared-sessions';
export type BlobUrlKeys = Extract<keyof CliSession, `${string}_blob_url`>;
export type FileName = BlobUrlKeys extends `${infer Base}_blob_url` ? Base : never;

function getBlobKey(sessionId: string, folderName: FolderName, filename: FileName): string {
  return `${folderName}/${sessionId}/${filename}.json`;
}

function mapResultsToBlobUrls(results: Array<{ filename: FileName; url: string | null }>) {
  const mapped: Record<string, unknown> = {};

  for (const item of results) {
    if (item.url != null) {
      mapped[`${item.filename}_blob_url`] = item.url;
    }
  }

  return mapped as Partial<Record<BlobUrlKeys, string>>;
}

export async function uploadBlob(
  sessionId: string,
  userId: string,
  folderName: FolderName,
  filename: FileName,
  rawContent: Readable,
  contentLength: number
) {
  const key = getBlobKey(sessionId, folderName, filename);

  const command = {
    Bucket: getR2CliSessionsBucketName(),
    Key: key,
    Body: rawContent,
    ContentType: 'application/json',
    ContentLength: contentLength,
    Metadata: {
      type: filename,
      sessionId: sessionId,
      userId: userId,
    },
  };

  await r2Client.send(new PutObjectCommand(command));

  return {
    [`${filename}_blob_url`]: key,
  } as Partial<Record<BlobUrlKeys, string>>;
}

export async function generateSignedUploadUrl(
  sessionId: string,
  userId: string,
  folderName: FolderName,
  filename: FileName,
  contentLength: number
) {
  const key = getBlobKey(sessionId, folderName, filename);

  const command = new PutObjectCommand({
    Bucket: getR2CliSessionsBucketName(),
    Key: key,
    ContentType: 'application/json',
    ContentLength: contentLength,
    Metadata: {
      type: filename,
      sessionId: sessionId,
      userId: userId,
    },
  });

  const signedUrl = await getSignedUrl(r2Client, command, {
    expiresIn: 900,
    signableHeaders: new Set(['content-length']),
  });

  return {
    signedUrl,
    key,
  };
}

export async function generateSignedUrls(
  sessionId: string,
  folderName: FolderName,
  filenames: FileName[]
) {
  const urlPromises = filenames.map(async filename => {
    const key = getBlobKey(sessionId, folderName, filename);
    const command = new GetObjectCommand({
      Bucket: getR2CliSessionsBucketName(),
      Key: key,
    });

    const url = await getSignedUrl(r2Client, command, {
      expiresIn: 900,
    });

    return { filename, url };
  });

  const results = await Promise.all(urlPromises);

  return mapResultsToBlobUrls(results);
}

export async function deleteBlobs(
  sessionId: string,
  blobsToDelete: {
    folderName: FolderName;
    filename: FileName;
  }[]
) {
  const objects = blobsToDelete.map(blob => ({
    Key: getBlobKey(sessionId, blob.folderName, blob.filename),
  }));

  await r2Client.send(
    new DeleteObjectsCommand({
      Bucket: getR2CliSessionsBucketName(),
      Delete: {
        Objects: objects,
        Quiet: true,
      },
    })
  );
}

export async function getBlobContent(blobKey: string): Promise<unknown> {
  const response = await r2Client.send(
    new GetObjectCommand({
      Bucket: getR2CliSessionsBucketName(),
      Key: blobKey,
    })
  );

  if (!response.Body) return null;

  const content = await response.Body.transformToString();

  return JSON.parse(content);
}

export async function copyBlobs(
  sourceId: string,
  sourceFolderName: FolderName,
  destinationId: string,
  destinationFolderName: FolderName,
  blobsToCopy: FileName[]
) {
  const filteredBlobsToCopy = blobsToCopy.filter(blob => blob != null);

  const copyPromises = filteredBlobsToCopy.map(async blobName => {
    const sourceKey = getBlobKey(sourceId, sourceFolderName, blobName);
    const destinationKey = getBlobKey(destinationId, destinationFolderName, blobName);

    try {
      await r2Client.send(
        new HeadObjectCommand({
          Bucket: getR2CliSessionsBucketName(),
          Key: sourceKey,
        })
      );
    } catch {
      return null;
    }

    const bucketName = getR2CliSessionsBucketName();
    await r2Client.send(
      new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: `${bucketName}/${sourceKey}`,
        Key: destinationKey,
      })
    );

    return { filename: blobName, url: destinationKey };
  });

  const results = await Promise.all(copyPromises);

  const validResults = results.filter(result => result !== null);

  return mapResultsToBlobUrls(validResults);
}
