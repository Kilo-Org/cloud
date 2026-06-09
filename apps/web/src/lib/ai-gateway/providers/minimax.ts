export const MINIMAX_CURRENT_MODEL_ID = 'minimax/minimax-m3';

export function isMinimaxModel(model: string) {
  return model.includes('minimax');
}
