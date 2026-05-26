export function isDeepseekModel(model: string) {
  return model.includes('deepseek');
}

export function isDeepseekV4Model(model: string) {
  return model === 'deepseek/deepseek-v4-pro' || model === 'deepseek/deepseek-v4-flash';
}
