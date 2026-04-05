import { QDRANT_API_KEY, QDRANT_HOST } from '@/lib/config.server';
import { QdrantClient } from '@qdrant/js-client-rest';

const qdrantHost = QDRANT_HOST;
const qdrantApiKey = QDRANT_API_KEY;

export const qdrantClient = new QdrantClient({
  host: qdrantHost,
  apiKey: qdrantApiKey,
  checkCompatibility: false,
  timeout: 30000,
});

export async function deleteCollectionIfExists(collectionName: string): Promise<void> {
  const checkExists = await qdrantClient.collectionExists(collectionName);
  if (!checkExists.exists) {
    console.log(`collection ${collectionName} does not exist...skipping deletion`);
    return;
  }
  console.log('deleting collection');
  const success = await qdrantClient.deleteCollection(collectionName);
  if (!success) {
    throw new Error(`Failed to delete collection ${collectionName}`);
  }
  console.log('collection deleted');
}

export async function ensureCollectionExists(
  collectionName: string,
  vectorSize: number = 256
): Promise<void> {
  console.log('checking collection exists');
  const checkExists = await qdrantClient.collectionExists(collectionName);
  if (checkExists.exists) {
    return;
  }
  console.log('connection does not exist...creating');
  const success = await qdrantClient.createCollection(collectionName, {
    // this disables global indexing
    // https://qdrant.tech/documentation/guides/multitenancy/#calibrate-performance
    hnsw_config: {
      m: 0,
      payload_m: 16,
    },
    vectors: {
      size: vectorSize,
      distance: 'Cosine',
      on_disk: true,
    },
    on_disk_payload: true,
  });
  if (!success) {
    throw new Error(`Failed to create collection ${collectionName}`);
  }

  // setup multi-tenant support
  await qdrantClient.createPayloadIndex(collectionName, {
    field_name: 'organization_id',
    field_schema: {
      type: 'uuid',
      is_tenant: true,
    },
  });

  await qdrantClient.createPayloadIndex(collectionName, {
    field_name: 'project_id',
    field_schema: {
      type: 'keyword',
    },
  });

  await qdrantClient.createPayloadIndex(collectionName, {
    field_name: 'git_branch',
    field_schema: {
      type: 'keyword',
    },
  });

  await qdrantClient.createPayloadIndex(collectionName, {
    field_name: 'file_path',
    field_schema: {
      type: 'keyword',
      // only used for file deletes, not searching so disk is fine
      on_disk: true,
    },
  });

  await qdrantClient.createPayloadIndex(collectionName, {
    field_name: 'created_at',
    field_schema: {
      type: 'datetime',
      // only used for bulk deletes, not searching so disk is fine
      on_disk: true,
    },
  });
}
