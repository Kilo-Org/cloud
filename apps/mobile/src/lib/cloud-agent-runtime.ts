import * as Crypto from 'expo-crypto';
import { configureCloudAgentSdkRuntime } from '@kilocode/cloud-agent-sdk';

configureCloudAgentSdkRuntime({
  randomBytes: Crypto.getRandomBytes,
  randomUUID: Crypto.randomUUID,
});
