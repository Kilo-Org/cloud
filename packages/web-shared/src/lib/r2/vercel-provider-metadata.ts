import {
  getAiProviderMetadataBucket,
  scheduleAiProviderMetadataArchive,
} from '@kilocode/web-shared/lib/r2/ai-provider-metadata-bucket';

export type VercelProviderMetadataCapture = (metadata: unknown, generationId?: string) => void;

const LOG_SOURCE = 'vercel-provider-metadata';

export function createVercelProviderMetadataCapture(): VercelProviderMetadataCapture | undefined {
  const target = getAiProviderMetadataBucket(LOG_SOURCE);
  if (!target) return undefined;

  let capturedMetadata: object | undefined;
  let capturedGenerationId: string | undefined;
  let waitingLogged = false;
  let registrationAttempted = false;

  return (metadata, generationId) => {
    if (typeof generationId === 'string' && generationId.length > 0) {
      capturedGenerationId = generationId;
    }
    if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
      capturedMetadata = metadata;
    }
    if (registrationAttempted) return;
    if (!capturedMetadata || !capturedGenerationId) {
      if (!waitingLogged && (metadata !== undefined || capturedGenerationId)) {
        console.debug(`[${LOG_SOURCE}] waiting for metadata and generation ID`, {
          generationId: capturedGenerationId,
          metadataReceived: Boolean(capturedMetadata),
          generationIdReceived: Boolean(capturedGenerationId),
        });
        waitingLogged = true;
      }
      return;
    }

    registrationAttempted = true;
    scheduleAiProviderMetadataArchive({
      target,
      logSource: LOG_SOURCE,
      logContext: { generationId: capturedGenerationId },
      key: `vercel/${capturedGenerationId}.json`,
      body: () => JSON.stringify(capturedMetadata),
    });
  };
}
