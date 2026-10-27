import { createHash, createHmac } from 'crypto';
import type { TFile } from 'librechat-data-provider';

/**
 * Exercises the real AWS presigner with throwaway credentials. Signing is a local
 * HMAC computation, so no AWS account or network is needed.
 */
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const ACCESS_KEY = 'AKIAFAKEFAKEFAKEFAKE';
const SECRET_KEY = 'fake-secret-access-key-for-offline-signing';
const BUCKET = 'presign-bucket';
const REGION = 'eu-west-1';
const HOST = 'storage.example.test:9000';

const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** Independent SigV4 query-string verification, written from the AWS spec rather than the SDK. */
function computeSignature(url: URL, secret: string): string {
  const params = new Map(url.searchParams.entries());
  params.delete('X-Amz-Signature');

  const canonicalQuery = [...params.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => Number(a > b) - Number(a < b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalPath = url.pathname
    .split('/')
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join('/');

  const canonicalRequest = [
    'GET',
    canonicalPath,
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const amzDate = params.get('X-Amz-Date') as string;
  const scope = (params.get('X-Amz-Credential') as string).split('/').slice(1).join('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const [date, region, service] = scope.split('/');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
  return createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}

const parseAmzDate = (value: string) =>
  Date.parse(value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));

describe('S3 presigned download URLs (real presigner, fake credentials)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  let crud: typeof import('../crud');

  const load = async () => {
    jest.resetModules();
    return import('../crud');
  };

  const fileFor = (key: string) => ({ storageKey: key, filepath: '', filename: 'x' }) as TFile;

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.AWS_REGION = REGION;
    process.env.AWS_BUCKET_NAME = BUCKET;
    process.env.AWS_ACCESS_KEY_ID = ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = SECRET_KEY;
    process.env.AWS_ENDPOINT_URL = `http://${HOST}`;
    process.env.AWS_FORCE_PATH_STYLE = 'true';
    process.env.S3_URL_EXPIRY_SECONDS = '120';
    crud = await load();
  }, 300_000);

  afterAll(() => {
    process.env = originalEnv;
  });

  it('produces a read-only, path-style, host-bound SigV4 URL without leaking the secret', async () => {
    const { getS3DownloadURL } = crud;
    const { url } = await getS3DownloadURL({ file: fileFor('uploads/user1/report.pdf') });
    const parsed = new URL(url);

    expect(parsed.host).toBe(HOST);
    expect(parsed.pathname).toBe(`/${BUCKET}/uploads/user1/report.pdf`);
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Credential')).toMatch(
      new RegExp(`^${ACCESS_KEY}/\\d{8}/${REGION}/s3/aws4_request$`),
    );
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(parsed.searchParams.get('x-id')).toBe('GetObject');
    expect(url).not.toContain(SECRET_KEY);
    expect(parsed.searchParams.has('X-Amz-Security-Token')).toBe(false);
  });

  it('matches an independently computed signature, and rejects any tampering', async () => {
    const { getS3DownloadURL } = crud;
    const { url } = await getS3DownloadURL({
      file: fileFor('uploads/user1/report.pdf'),
      customFilename: 'report.pdf',
      contentType: 'application/pdf',
    });
    const parsed = new URL(url);
    const signature = parsed.searchParams.get('X-Amz-Signature');

    expect(computeSignature(parsed, SECRET_KEY)).toBe(signature);
    expect(computeSignature(parsed, 'a-different-secret')).not.toBe(signature);

    const otherKey = new URL(url);
    otherKey.pathname = `/${BUCKET}/uploads/user2/report.pdf`;
    expect(computeSignature(otherKey, SECRET_KEY)).not.toBe(signature);

    const longer = new URL(url);
    longer.searchParams.set('X-Amz-Expires', '604800');
    expect(computeSignature(longer, SECRET_KEY)).not.toBe(signature);

    const inline = new URL(url);
    inline.searchParams.set('response-content-disposition', 'inline');
    expect(computeSignature(inline, SECRET_KEY)).not.toBe(signature);
  });

  it('signs the attachment disposition and content type into the URL', async () => {
    const { getS3DownloadURL } = crud;
    const { url } = await getS3DownloadURL({
      file: fileFor('uploads/user1/page.html'),
      customFilename: 'page.html',
      contentType: 'text/html',
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="page.html"',
    );
    expect(parsed.searchParams.get('response-content-type')).toBe('text/html');
  });

  it('reports an expiresAt that agrees with the signed X-Amz-Date + X-Amz-Expires', async () => {
    const { getS3DownloadURL } = crud;
    const { url, expiresAt } = await getS3DownloadURL({
      file: fileFor('uploads/user1/a.txt'),
      expiresIn: 900,
    });
    const parsed = new URL(url);
    const signedExpiry =
      parseAmzDate(parsed.searchParams.get('X-Amz-Date') as string) +
      Number(parsed.searchParams.get('X-Amz-Expires')) * 1000;

    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(Math.abs(expiresAt.getTime() - signedExpiry)).toBeLessThanOrEqual(2000);
  });

  it.each([
    ['spaces and plus', 'uploads/user1/my report+final.pdf'],
    ['percent and hash', 'uploads/user1/100%#1.pdf'],
    ['question mark and ampersand', 'uploads/user1/a?b&c=d.pdf'],
    ['unicode', 'uploads/user1/relatório-日本語-😀.pdf'],
    ['parentheses and apostrophe', "uploads/user1/it's (copy).pdf"],
  ])('round-trips a key with %s and still verifies', async (_label, key) => {
    const { getS3DownloadURL } = crud;
    const { url } = await getS3DownloadURL({
      file: fileFor(key),
      customFilename: 'relatório (1).pdf',
    });
    const parsed = new URL(url);
    const decodedKey = decodeURIComponent(parsed.pathname).replace(`/${BUCKET}/`, '');

    expect(decodedKey).toBe(key);
    expect(computeSignature(parsed, SECRET_KEY)).toBe(parsed.searchParams.get('X-Amz-Signature'));
  });

  it('uses virtual-hosted style when no custom endpoint is configured', async () => {
    const savedEndpoint = process.env.AWS_ENDPOINT_URL;
    const savedPathStyle = process.env.AWS_FORCE_PATH_STYLE;
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_FORCE_PATH_STYLE;
    try {
      const { getS3DownloadURL } = await load();
      const { url } = await getS3DownloadURL({ file: fileFor('uploads/user1/a.txt') });
      const parsed = new URL(url);

      expect(parsed.host).toBe(`${BUCKET}.s3.${REGION}.amazonaws.com`);
      expect(parsed.pathname).toBe('/uploads/user1/a.txt');
      expect(computeSignature(parsed, SECRET_KEY)).toBe(parsed.searchParams.get('X-Amz-Signature'));
    } finally {
      process.env.AWS_ENDPOINT_URL = savedEndpoint;
      process.env.AWS_FORCE_PATH_STYLE = savedPathStyle;
    }
  });
});
