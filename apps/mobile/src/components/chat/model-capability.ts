const CAPABILITY_KEYS = {
  toolsImages: 'modelChat.backends.modelToolsImages',
  tools: 'modelChat.backends.modelTools',
  images: 'modelChat.backends.imagesNoTools',
  none: 'modelChat.backends.textOnly',
} as const;

/** The sentence that says whether a model receives tools and reads images. */
export function modelCapabilityKey(tools: boolean, images: boolean) {
  if (tools) {
    return images ? CAPABILITY_KEYS.toolsImages : CAPABILITY_KEYS.tools;
  }
  return images ? CAPABILITY_KEYS.images : CAPABILITY_KEYS.none;
}
