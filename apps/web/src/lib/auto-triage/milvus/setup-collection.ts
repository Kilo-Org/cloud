import type { MilvusRestClient } from '@/lib/code-indexing/milvus-rest-client';

const COLLECTION_NAME = 'auto_triage_tickets';

/**
 * Ensures the auto_triage_tickets Milvus collection exists with proper configuration.
 * This collection stores issue embeddings for duplicate detection.
 *
 * Configuration:
 * - Vector size: 1024 (Mistral mistral-embed dimensions)
 * - Distance metric: Cosine
 * - Partition key: organization_id (for multi-tenancy optimization)
 *
 * Fields:
 * - id (VarChar, primary key) - MD5 hash of unique identifier
 * - vector (FloatVector, 1024 dims) - Mistral embedding
 * - organization_id (VarChar, partition key) - for multi-tenant filtering
 * - ticket_id (VarChar) - reference to triage ticket
 * - repo_full_name (VarChar) - for repository filtering
 * - issue_number (Int32) - GitHub issue number
 * - issue_title (VarChar) - issue title for display
 * - source_text (VarChar) - preprocessed text used for embedding
 * - created_at (Int64) - timestamp in milliseconds
 *
 * @param milvusClient - Milvus REST client instance
 */
export async function ensureTriageCollectionExists(milvusClient: MilvusRestClient): Promise<void> {
  console.log(`Checking if collection ${COLLECTION_NAME} exists...`);
  const checkExists = await milvusClient.hasCollection({ collection_name: COLLECTION_NAME });

  if (checkExists.value) {
    console.log(`Collection ${COLLECTION_NAME} already exists`);
    return;
  }

  console.log(`Collection ${COLLECTION_NAME} does not exist...creating`);

  // Create collection with Mistral embedding dimensions (1024)
  await milvusClient.createCollection({
    collection_name: COLLECTION_NAME,
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
        dim: 1024, // Mistral mistral-embed dimensions
      },
      {
        name: 'organization_id',
        data_type: 'VarChar',
        max_length: 64,
        nullable: false,
        is_partition_key: true,
      },
      {
        name: 'ticket_id',
        data_type: 'VarChar',
        max_length: 64,
      },
      {
        name: 'repo_full_name',
        data_type: 'VarChar',
        max_length: 512,
      },
      {
        name: 'issue_number',
        data_type: 'Int32',
      },
      {
        name: 'issue_title',
        data_type: 'VarChar',
        max_length: 1024,
      },
      {
        name: 'source_text',
        data_type: 'VarChar',
        max_length: 32000,
      },
      {
        name: 'created_at',
        data_type: 'Int64',
      },
    ],
  });

  console.log(`Collection ${COLLECTION_NAME} created successfully`);

  // Create indexes for efficient filtering
  // Vector index for similarity search
  console.log('Creating vector index...');
  await milvusClient.createIndex({
    collection_name: COLLECTION_NAME,
    field_name: 'vector',
    index_type: 'AUTOINDEX',
    metric_type: 'COSINE',
  });

  // Scalar indexes for filtering
  console.log('Creating index for organization_id...');
  await milvusClient.createIndex({
    collection_name: COLLECTION_NAME,
    field_name: 'organization_id',
    index_type: 'INVERTED',
  });

  console.log('Creating index for repo_full_name...');
  await milvusClient.createIndex({
    collection_name: COLLECTION_NAME,
    field_name: 'repo_full_name',
    index_type: 'INVERTED',
  });

  console.log('Creating index for ticket_id...');
  await milvusClient.createIndex({
    collection_name: COLLECTION_NAME,
    field_name: 'ticket_id',
    index_type: 'INVERTED',
  });

  console.log('Creating index for created_at...');
  await milvusClient.createIndex({
    collection_name: COLLECTION_NAME,
    field_name: 'created_at',
    index_type: 'STL_SORT',
  });

  // Load collection into memory for searching
  console.log('Loading collection into memory...');
  await milvusClient.loadCollection({ collection_name: COLLECTION_NAME });

  console.log(`All indexes created and collection loaded for ${COLLECTION_NAME}`);
}

/**
 * Deletes the auto_triage_tickets collection if it exists.
 * Useful for testing or resetting the collection.
 *
 * @param milvusClient - Milvus REST client instance
 */
export async function deleteTriageCollectionIfExists(
  milvusClient: MilvusRestClient
): Promise<void> {
  const checkExists = await milvusClient.hasCollection({ collection_name: COLLECTION_NAME });

  if (!checkExists.value) {
    console.log(`Collection ${COLLECTION_NAME} does not exist...skipping deletion`);
    return;
  }

  console.log(`Deleting collection ${COLLECTION_NAME}...`);
  await milvusClient.dropCollection({ collection_name: COLLECTION_NAME });

  console.log(`Collection ${COLLECTION_NAME} deleted successfully`);
}
