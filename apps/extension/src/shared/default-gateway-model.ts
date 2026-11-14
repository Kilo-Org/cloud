import type { KiloGatewayModelOption } from './kilo-api-client';

const autoModelPrefix = 'kilo-auto/';
const autoFrontierModelId = 'kilo-auto/frontier';

export const getDefaultGatewayModelId = (
  models: readonly KiloGatewayModelOption[]
): string | undefined => {
  const frontier = models.find(model => model.id === autoFrontierModelId);

  if (frontier !== undefined) {
    return frontier.id;
  }

  const autoModel = models.find(model => model.id.startsWith(autoModelPrefix));

  if (autoModel !== undefined) {
    return autoModel.id;
  }

  const preferredModel = models.find(model => model.isPreferred);

  return (preferredModel ?? models[0])?.id;
};
