import { NextResponse } from 'next/server';
import { KILO_EMBEDDING_MODEL_CATALOG } from '@/lib/ai-gateway/embeddings/kilo-embedding-models';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(KILO_EMBEDDING_MODEL_CATALOG);
}
