const PROVIDER_ALIASES: Record<string, string> = {
  ai21labs: 'ai21',
  amazonbedrock: 'bedrock',
  blackboxai: 'blackbox',
  claudeaws: 'claudeplatformonaws',
  claudeonaws: 'claudeplatformonaws',
  custom: 'other',
  directbyok: 'other',
  fireworksai: 'fireworks',
  friendliai: 'friendli',
  googleaistudio: 'google',
  longcat: 'meituan',
  martian: 'stealth',
  meituanlongcat: 'meituan',
  novitaai: 'novita',
  particleai: 'particle',
  sakanaai: 'sakana',
  seed: 'bytedance',
  spacexai: 'xai',
  spacexsi: 'xai',
  togetherai: 'together',
  unknown: 'other',
  vertex: 'google',
  vertexanthropic: 'google',
  weightsbiases: 'wandb',
};

const PROVIDER_NAMES: Record<string, string> = {
  ai21: 'AI21 Labs',
  aionlabs: 'Aion Labs',
  akashml: 'AkashML',
  antdigital: 'Ant Digital',
  arceeai: 'Arcee AI',
  assemblyai: 'AssemblyAI',
  atlascloud: 'Atlas Cloud',
  bedrock: 'Amazon Bedrock',
  blackbox: 'BLACKBOX AI',
  blackforestlabs: 'Black Forest Labs',
  boundless: 'Boundless',
  bytedance: 'ByteDance',
  byteplus: 'BytePlus',
  claudeplatformonaws: 'Claude Platform on AWS',
  corethink: 'CoreThink',
  coreweave: 'CoreWeave',
  dekallm: 'Deka LLM',
  deepinfra: 'DeepInfra',
  deepseek: 'DeepSeek',
  digitalocean: 'DigitalOcean',
  edenai: 'Eden AI',
  fireworks: 'Fireworks AI',
  friendli: 'FriendliAI',
  genlabs: 'GenLabs',
  gigapotato: 'Giga Potato',
  gmicloud: 'GMI Cloud',
  google: 'Google',
  inception: 'Inception',
  inceptron: 'Inceptron',
  inferencenet: 'Inference.net',
  ionet: 'io.net',
  ionstream: 'ionstream',
  mara: 'MARA',
  meituan: 'Meituan LongCat',
  minimax: 'MiniMax',
  modelrun: 'ModelRun',
  moonshotai: 'Moonshot AI',
  ncompass: 'NCompass',
  nearai: 'NEAR AI',
  nexagi: 'Nex AGI',
  nextbit: 'NextBit',
  novita: 'Novita AI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  openaichatgpt: 'OpenAI (ChatGPT)',
  opencodego: 'OpenCode Go',
  openinference: 'OpenInference',
  orcarouter: 'OrcaRouter',
  other: 'Other',
  particle: 'Particle AI',
  primeintellect: 'Prime Intellect',
  runinfra: 'RunInfra',
  runware: 'Runware',
  sambanova: 'SambaNova',
  sailresearch: 'Sail Research',
  sakana: 'Sakana AI',
  scaledown: 'ScaleDown',
  siliconflow: 'SiliconFlow',
  stealth: 'Stealth',
  stepfun: 'StepFun',
  streamlake: 'StreamLake',
  thinkingmachines: 'Thinking Machines',
  together: 'Together AI',
  typesafe: 'TypeSafe',
  wandb: 'Weights & Biases',
  xai: 'SpaceXSI',
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
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(^|\s)\w/g, character => character.toUpperCase());

  return { key, name: PROVIDER_NAMES[key] ?? fallbackName };
}
