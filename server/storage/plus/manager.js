import { S3StorageAdapter } from './s3-adapter.js';

let singleton;

export function getPlusStorageManager() {
  if (!singleton) {
    singleton = {
      createAdapter(config) {
        if (config.provider !== 'backblaze-b2') {
          const error = new Error('Only Backblaze B2 storage is enabled in this release.');
          error.code = 'INVALID_PROVIDER';
          throw error;
        }
        return new S3StorageAdapter(config);
      }
    };
  }
  return singleton;
}
