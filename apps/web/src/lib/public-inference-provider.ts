const PROVIDER_ALIASES: Record<string, string> = {
  amazonbedrock: 'bedrock',
  custom: 'other',
  directbyok: 'other',
  googleaistudio: 'google',
  inceptron: 'inception',
  martian: 'stealth',
  seed: 'bytedance',
  togetherai: 'together',
  unknown: 'other',
  vertex: 'google',
  vertexanthropic: 'google',
};

const PROVIDER_NAMES: Record<string, string> = {
  ai21: 'AI21',
  aionlabs: 'Aion Labs',
  akashml: 'Akash ML',
  arceeai: 'Arcee AI',
  atlascloud: 'Atlas Cloud',
  bedrock: 'Amazon Bedrock',
  bytedance: 'ByteDance',
  dekallm: 'DekaLLM',
  deepinfra: 'DeepInfra',
  deepseek: 'DeepSeek',
  digitalocean: 'DigitalOcean',
  fireworks: 'Fireworks AI',
  friendli: 'Friendli AI',
  gmicloud: 'GMI Cloud',
  google: 'Google',
  inception: 'Inception',
  ionet: 'IO.net',
  minimax: 'MiniMax',
  modelrun: 'ModelRun',
  moonshotai: 'Moonshot AI',
  nexagi: 'Nex AGI',
  nextbit: 'NextBit',
  novita: 'Novita AI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  openinference: 'OpenInference',
  other: 'Other',
  sambanova: 'SambaNova',
  siliconflow: 'SiliconFlow',
  stealth: 'Stealth',
  stepfun: 'StepFun',
  streamlake: 'StreamLake',
  together: 'Together AI',
  unknown: 'Unknown',
  wandb: 'Weights & Biases',
  xai: 'xAI',
  zai: 'Z.ai',
};

export type NormalizedPublicInferenceProvider = {
  key: string;
  name: string;
};

export function normalizePublicInferenceProvider(
  provider: string
): NormalizedPublicInferenceProvider {
  const normalizedKey = provider.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = PROVIDER_ALIASES[normalizedKey] ?? normalizedKey;
  const fallbackName = provider
    .trim()
    .toLowerCase()
    .replace(/(^|[\s_-])\w/g, character => character.toUpperCase());

  return { key, name: PROVIDER_NAMES[key] ?? fallbackName };
}
