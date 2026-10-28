import { generateKeyPairSync, verify } from 'crypto';
import type { TFile } from 'librechat-data-provider';
import type { CloudFrontFullConfig } from '~/cdn/cloudfront';

/**
 * Exercises the real CloudFront signer with a throwaway RSA key pair. Signing is a local
 * computation, so no distribution or AWS account is needed.
 */
const mockGetCloudFrontConfig = jest.fn<CloudFrontFullConfig | null, []>();

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/cdn/cloudfront', () => ({
  getCloudFrontConfig: mockGetCloudFrontConfig,
}));

const DOMAIN = 'https://d123.cloudfront.net';
const KEY_PAIR_ID = 'KTESTKEYPAIRID';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** CloudFront's URL-safe base64 maps `+`, `=` and `/` to `-`, `_` and `~`. */
const decodeCloudFrontBase64 = (value: string) =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');

const fileFor = (key: string) => ({ storageKey: key, filepath: '', filename: 'x' }) as TFile;

type Policy = {
  Statement: Array<{
    Resource: string;
    Condition: { DateLessThan: { 'AWS:EpochTime': number } };
  }>;
};

const inspect = (signedUrl: string) => {
  const url = new URL(signedUrl);
  const policyBytes = decodeCloudFrontBase64(url.searchParams.get('Policy') as string);
  const signature = decodeCloudFrontBase64(url.searchParams.get('Signature') as string);
  return {
    url,
    policy: JSON.parse(policyBytes.toString()) as Policy,
    policyBytes,
    signature,
    verifies: (data: Buffer = policyBytes) => verify('RSA-SHA1', data, publicKey, signature),
  };
};

describe('CloudFront signed download URLs (real signer, throwaway key)', () => {
  let getCloudFrontDownloadURL: typeof import('../crud').getCloudFrontDownloadURL;

  const config = (urlExpiry: number): CloudFrontFullConfig => ({
    domain: DOMAIN,
    invalidateOnDelete: false,
    imageSigning: 'cookies',
    urlExpiry,
    cookieExpiry: 1800,
    includeRegionInPath: false,
    requireSignedAccess: true,
    privateKey: PRIVATE_KEY_PEM,
    keyPairId: KEY_PAIR_ID,
  });

  beforeAll(async () => {
    process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-1';
    process.env.AWS_BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'presign-bucket';
    ({ getCloudFrontDownloadURL } = await import('../crud'));
  }, 300_000);

  beforeEach(() => {
    mockGetCloudFrontConfig.mockReturnValue(config(7200));
  });

  it('signs a policy scoped to one object that verifies with the public key', async () => {
    const file = fileFor('uploads/user1/report.pdf');

    const { url: signedUrl } = await getCloudFrontDownloadURL({
      file,
      customFilename: 'report.pdf',
      contentType: 'application/pdf',
      expiresIn: 300,
    });
    const { url, policy, verifies } = inspect(signedUrl);

    expect(url.origin).toBe(DOMAIN);
    expect(url.pathname).toBe('/uploads/user1/report.pdf');
    expect(url.searchParams.get('Key-Pair-Id')).toBe(KEY_PAIR_ID);
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0].Resource).toBe(`${DOMAIN}/uploads/user1/report.pdf?*`);
    expect(verifies()).toBe(true);
    expect(signedUrl).not.toContain('PRIVATE KEY');
  });

  it('expires after the requested lifetime, not cloudfront.urlExpiry', async () => {
    const before = Math.floor(Date.now() / 1000);

    const { url: signedUrl, expiresAt } = await getCloudFrontDownloadURL({
      file: fileFor('uploads/user1/report.pdf'),
      customFilename: 'report.pdf',
      expiresIn: 300,
    });
    const epoch = inspect(signedUrl).policy.Statement[0].Condition.DateLessThan['AWS:EpochTime'];

    expect(epoch).toBe(Math.floor(expiresAt.getTime() / 1000));
    expect(epoch - before).toBeGreaterThanOrEqual(299);
    expect(epoch - before).toBeLessThanOrEqual(302);
  });

  it('falls back to cloudfront.urlExpiry when no lifetime is requested', async () => {
    const before = Math.floor(Date.now() / 1000);

    const { url: signedUrl } = await getCloudFrontDownloadURL({
      file: fileFor('uploads/user1/report.pdf'),
      customFilename: 'report.pdf',
    });
    const epoch = inspect(signedUrl).policy.Statement[0].Condition.DateLessThan['AWS:EpochTime'];

    expect(epoch - before).toBeGreaterThanOrEqual(7199);
    expect(epoch - before).toBeLessThanOrEqual(7202);
  });

  it('uses a canned policy with the requested expiry when there are no response overrides', async () => {
    const { url: signedUrl, expiresAt } = await getCloudFrontDownloadURL({
      file: fileFor('uploads/user1/report.pdf'),
      expiresIn: 300,
    });
    const url = new URL(signedUrl);

    expect(url.searchParams.has('Policy')).toBe(false);
    expect(Number(url.searchParams.get('Expires'))).toBe(Math.floor(expiresAt.getTime() / 1000));
    expect(url.searchParams.get('Key-Pair-Id')).toBe(KEY_PAIR_ID);
    expect(url.searchParams.get('Signature')).toBeTruthy();
  });

  it('rejects a policy rewritten to another object or a later expiry', async () => {
    const { url: signedUrl } = await getCloudFrontDownloadURL({
      file: fileFor('uploads/user1/report.pdf'),
      customFilename: 'report.pdf',
      expiresIn: 300,
    });
    const { policy, verifies } = inspect(signedUrl);

    const otherObject = structuredClone(policy);
    otherObject.Statement[0].Resource = `${DOMAIN}/uploads/user2/secret.pdf?*`;
    const later = structuredClone(policy);
    later.Statement[0].Condition.DateLessThan['AWS:EpochTime'] += 86400;

    expect(verifies(Buffer.from(JSON.stringify(otherObject)))).toBe(false);
    expect(verifies(Buffer.from(JSON.stringify(later)))).toBe(false);
  });

  it('keeps response overrides inside the signed resource wildcard', async () => {
    const { url: signedUrl } = await getCloudFrontDownloadURL({
      file: fileFor('uploads/user1/report.pdf'),
      customFilename: 'my report.pdf',
      expiresIn: 300,
    });
    const { url } = inspect(signedUrl);

    expect(url.searchParams.get('response-content-disposition')).toContain('my report.pdf');
  });
});
