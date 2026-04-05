import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { r2Client } from '@/lib/r2/client';
import { getEnvVariable } from '@/lib/dotenvx';

function getAppBuilderAssetsBucketName(): string {
  const name = getEnvVariable('APP_BUILDER_ASSETS_BUCKET_NAME');
  if (!name) {
    throw new Error('APP_BUILDER_ASSETS_BUCKET_NAME environment variable is required');
  }
  return name;
}

async function deleteProjectAssets(
  projectId: string,
  owner: { type: 'user' | 'org'; id: string }
): Promise<void> {
  const bucketName = getAppBuilderAssetsBucketName();
  const ownerPrefix = owner.type === 'user' ? `user_${owner.id}` : `org_${owner.id}`;
  const prefix = `${ownerPrefix}/${projectId}/`;

  let continuationToken: string | undefined;
  do {
    const listResult = await r2Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    if (listResult.Contents && listResult.Contents.length > 0) {
      await r2Client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: listResult.Contents.flatMap(obj => (obj.Key ? [{ Key: obj.Key }] : [])),
          },
        })
      );
    }

    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
  } while (continuationToken);
}

export { deleteProjectAssets };
