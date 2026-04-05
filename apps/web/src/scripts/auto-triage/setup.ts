import {
  ensureTriageCollectionExists,
  deleteTriageCollectionIfExists,
} from '@/lib/auto-triage/milvus/setup-collection';
import { MilvusRestClient } from '@/lib/code-indexing/milvus-rest-client';
import { getEnvVariable } from '@/lib/dotenvx';

export async function run() {
  const args = process.argv.slice(2);
  const forceRecreate = args.includes('--force');

  try {
    // Create Milvus client directly without server-only dependencies
    const milvusAddress = getEnvVariable('MILVUS_ADDRESS');
    const milvusToken = getEnvVariable('MILVUS_TOKEN');

    if (!milvusAddress) {
      throw new Error('MILVUS_ADDRESS environment variable is required');
    }

    const milvusClient = new MilvusRestClient({
      address: milvusAddress,
      token: milvusToken,
      timeout: 30000,
    });

    console.log('='.repeat(60));
    console.log('Auto Triage Milvus Collection Setup');
    console.log('='.repeat(60));
    console.log();

    if (forceRecreate) {
      console.log('⚠️  Force flag detected - will delete and recreate collection');
      console.log();
      await deleteTriageCollectionIfExists(milvusClient);
      console.log();
    }

    await ensureTriageCollectionExists(milvusClient);

    console.log();
    console.log('='.repeat(60));
    console.log('✅ Setup completed successfully!');
    console.log('='.repeat(60));
    console.log();
    console.log('Collection: auto_triage_tickets');
    console.log('Vector size: 1024 (Mistral mistral-embed)');
    console.log('Distance metric: Cosine');
    console.log('Indexes created:');
    console.log('  - organization_id (partition key)');
    console.log('  - repo_full_name (inverted)');
    console.log('  - ticket_id (inverted)');
    console.log();

    process.exit(0);
  } catch (error) {
    console.error();
    console.error('='.repeat(60));
    console.error('❌ Setup failed!');
    console.error('='.repeat(60));
    console.error();
    console.error('Error:', error instanceof Error ? error.message : String(error));

    if (error instanceof Error && error.stack) {
      console.error();
      console.error('Stack trace:');
      console.error(error.stack);
    }

    console.error();
    process.exit(1);
  }
}
