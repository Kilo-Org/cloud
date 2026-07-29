export function isFreeNemotronModel(model: string) {
  return model.includes('nemotron') && model.endsWith(':free');
}

export const NVIDIA_TRIAL_TOS =
  'For NVIDIA free endpoints (Super/Ultra/etc): Trial use only - do not submit personal or confidential data. Your use is logged for security purposes and to improve NVIDIA products and services. The logged session data for improvement purposes is not linked to your identity or any persistent identifier. For more information about our data processing practices, see our [Privacy Policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/). By interacting with this endpoint, you consent to our collection, recording, and use of such information and the [NVIDIA API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf).';
