import * as Crypto from 'expo-crypto';

export const newId = (): string => Crypto.randomUUID();
