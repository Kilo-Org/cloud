/** The identity a BYOK data key is bound to, sent to the KMS service and used to key the data key cache. */
export type ByokKmsContext = {
  key_id: string;
  owner_type: 'user' | 'organization';
  owner_id: string;
  provider_id: string;
};
