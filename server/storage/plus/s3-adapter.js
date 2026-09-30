import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command
} from '@aws-sdk/client-s3';
import {
  getSignedUrl
} from '@aws-sdk/s3-request-presigner';

export class S3StorageAdapter {
  constructor({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle = true }) {
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('Complete B2 connection configuration is required');
    }
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle: Boolean(forcePathStyle),
      credentials: { accessKeyId, secretAccessKey }
    });
  }

  async list(prefix = '', maxKeys = 1000) {
    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: maxKeys
    }));
    return {
      objects: (result.Contents || []).map(x => ({ key: x.Key, size: x.Size, lastModified: x.LastModified })),
      truncated: Boolean(result.IsTruncated)
    };
  }

  async upload(key, body, contentType = 'application/octet-stream') {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    }));
    return { success: true, key };
  }

  async download(key) {
    return this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    return { success: true, key };
  }

  async exists(key) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      const status = e?.$metadata?.httpStatusCode;
      if (status === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey') return false;
      throw e;
    }
  }

  async createUploadUrl(key, expiresIn = 900, contentType = 'application/octet-stream') {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return { key, url: await getSignedUrl(this.client, command, { expiresIn }) };
  }

  async createDownloadUrl(key, expiresIn = 900) {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return { key, url: await getSignedUrl(this.client, command, { expiresIn }) };
  }
}
