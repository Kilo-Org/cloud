import expoConstants from 'expo-constants';

export const API_BASE_URL: string =
  (expoConstants.expoConfig?.extra?.apiBaseUrl as string | undefined) ?? 'https://api.kilo.ai';
