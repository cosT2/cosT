import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readFile } from 'node:fs/promises';
const account = process.env.R2_ACCOUNT_ID || '';
const bucket = process.env.R2_BUCKET || '';
const publicMedia = process.env.CET6_MEDIA_ORIGIN || '';
let mediaOrigin = '';
if (publicMedia) {
  const url = new URL(publicMedia);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('CET6_MEDIA_ORIGIN must be an HTTPS origin');
  mediaOrigin = url.origin;
}
export const cloudResourceOrigin = mediaOrigin || (account ? `https://${account}.r2.cloudflarestorage.com` : '');
export const publicMediaKeys = mediaOrigin
  ? new Set(Object.keys(JSON.parse(await readFile(new URL('./content/cloud-media.json', import.meta.url), 'utf8'))))
  : null;
if (account && !/^[a-f0-9]{32}$/i.test(account)) throw new Error('Invalid R2_ACCOUNT_ID');
const enabled = Boolean(account && bucket && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
if ([account, process.env.R2_ACCESS_KEY_ID, process.env.R2_SECRET_ACCESS_KEY].some(Boolean) && !enabled)
  throw new Error('R2 configuration is incomplete');
const client = enabled ? new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } }) : null;
export async function resourceDownloadURL(key, method = 'GET') {
  if (!['GET', 'HEAD'].includes(method)) throw new Error('Unsupported resource method');
  if (!key || key.startsWith('/') || key.split('/').some(p => p === '..' || p === '.') || /[\x00-\x1f\\]/.test(key))
    throw new Error('Invalid resource key');
  if (mediaOrigin) return publicMediaKeys.has(key) ? `${mediaOrigin}/${key.split('/').map(encodeURIComponent).join('/')}` : null;
  if (!client) return null;
  const Command = method === 'HEAD' ? HeadObjectCommand : GetObjectCommand;
  return getSignedUrl(client, new Command({ Bucket: bucket, Key: key }), { expiresIn: 6 * 3600 });
}
