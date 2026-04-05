import { MILVUS_ADDRESS, MILVUS_TOKEN } from '@/lib/config.server';
import { MilvusRestClient } from './milvus-rest-client';

export type { DataType } from './milvus-rest-client';

export function getMilvusClient(): MilvusRestClient {
  return new MilvusRestClient({
    address: MILVUS_ADDRESS || '',
    token: MILVUS_TOKEN,
    timeout: 30000,
  });
}

export async function deleteCollectionIfExists(collectionName: string): Promise<void> {
  const client = getMilvusClient();
  const hasCollection = await client.hasCollection({ collection_name: collectionName });
  if (!hasCollection.value) {
    console.log(`collection ${collectionName} does not exist...skipping deletion`);
    return;
  }
  console.log('deleting collection');
  await client.dropCollection({ collection_name: collectionName });
  console.log('collection deleted');
}

export async function ensureCollectionExists(
  collectionName: string,
  vectorSize: number = 256
): Promise<void> {
  const client = getMilvusClient();
  console.log('checking collection exists');
  const hasCollection = await client.hasCollection({ collection_name: collectionName });
  if (hasCollection.value) {
    return;
  }
  console.log('collection does not exist...creating');

  // Create collection with schema
  await client.createCollection({
    collection_name: collectionName,
    num_partitions: 256,
    auto_id: false,
    properties: {
      'partitionkey.isolation': true,
    },
    fields: [
      {
        name: 'id',
        data_type: 'VarChar',
        is_primary_key: true,
        max_length: 64,
      },
      {
        name: 'vector',
        data_type: 'FloatVector',
        dim: vectorSize,
      },
      {
        name: 'organization_id',
        data_type: 'VarChar',
        max_length: 64,
        nullable: false,
        is_partition_key: true,
      },
      {
        name: 'project_id',
        data_type: 'VarChar',
        max_length: 512,
      },
      {
        name: 'file_path',
        data_type: 'VarChar',
        max_length: 4096,
      },
      {
        name: 'file_hash',
        data_type: 'VarChar',
        max_length: 256,
      },
      {
        name: 'start_line',
        data_type: 'Int32',
      },
      {
        name: 'end_line',
        data_type: 'Int32',
      },
      {
        name: 'git_branch',
        data_type: 'VarChar',
        max_length: 1024,
      },
      {
        name: 'created_at',
        data_type: 'Int64',
      },
    ],
  });

  // Create indexes for efficient filtering
  // Vector index for similarity search
  await client.createIndex({
    collection_name: collectionName,
    field_name: 'vector',
    index_type: 'AUTOINDEX',
    metric_type: 'COSINE',
  });

  // Scalar indexes for filtering
  await client.createIndex({
    collection_name: collectionName,
    field_name: 'organization_id',
    index_type: 'INVERTED',
  });

  await client.createIndex({
    collection_name: collectionName,
    field_name: 'project_id',
    index_type: 'INVERTED',
  });

  await client.createIndex({
    collection_name: collectionName,
    field_name: 'git_branch',
    index_type: 'INVERTED',
  });

  await client.createIndex({
    collection_name: collectionName,
    field_name: 'file_path',
    index_type: 'INVERTED',
  });

  // Load collection into memory for searching
  await client.loadCollection({ collection_name: collectionName });

  console.log('collection created and loaded');
}
