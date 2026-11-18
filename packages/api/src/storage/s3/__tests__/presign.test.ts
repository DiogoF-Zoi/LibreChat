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

const parseAmzDate = (value: string) =>
  Date.parse(value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));

const fileFor = (key: string) => ({ storageKey: key, filepath: '', filename: 'x' }) as TFile;

describe('S3 presigned download URLs (real presigner, fake credentials)', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let getS3DownloadURL: typeof import('../crud').getS3DownloadURL;

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.AWS_REGION = REGION;
    process.env.AWS_BUCKET_NAME = BUCKET;
    process.env.AWS_ACCESS_KEY_ID = ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = SECRET_KEY;
    process.env.AWS_ENDPOINT_URL = `http://${HOST}`;
    process.env.AWS_FORCE_PATH_STYLE = 'true';
    process.env.S3_URL_EXPIRY_SECONDS = '120';
    jest.resetModules();
    ({ getS3DownloadURL } = await import('../crud'));
  }, 300_000);

  afterAll(() => {
    process.env = originalEnv;
  });

  /** Swaps the client's credentials for temporary ones expiring `inMs` from now. */
  const withTemporaryCredentials = async <T>(inMs: number, run: () => Promise<T>): Promise<T> => {
    const { initializeS3 } = await import('~/cdn/s3');
    const client = initializeS3()!;
    const staticCredentials = client.config.credentials;
    client.config.credentials = async () => ({
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      sessionToken: 'session-token',
      expiration: new Date(Date.now() + inMs),
    });
    try {
      return await run();
    } finally {
      client.config.credentials = staticCredentials;
    }
  };

  it('produces a read-only, host-bound GetObject URL without leaking the secret', async () => {
    const { url } = await getS3DownloadURL({ file: fileFor('uploads/user1/report.pdf') });
    const parsed = new URL(url);

    expect(parsed.host).toBe(HOST);
    expect(parsed.pathname).toBe(`/${BUCKET}/uploads/user1/report.pdf`);
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(parsed.searchParams.get('x-id')).toBe('GetObject');
    expect(url).not.toContain(SECRET_KEY);
  });

  it.each([
    ['page.html', `attachment; filename="page.html"; filename*=UTF-8''page.html`],
    [
      'relatório; "final".xlsx',
      `attachment; filename="relato_rio; _final_.xlsx"; filename*=UTF-8''relat%C3%B3rio%3B%20%22final%22.xlsx`,
    ],
    [undefined, `attachment; filename="download"; filename*=UTF-8''download`],
    ['', `attachment; filename="download"; filename*=UTF-8''download`],
  ])('signs an ASCII-only attachment disposition for %p', async (customFilename, expected) => {
    const { url } = await getS3DownloadURL({
      file: fileFor('uploads/user1/page.html'),
      customFilename,
      contentType: 'text/html',
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response-content-disposition')).toBe(expected);
    expect(parsed.searchParams.get('response-content-type')).toBe('text/html');
  });

  it('never reports an expiresAt later than the signed X-Amz-Date + X-Amz-Expires', async () => {
    /** Just before a second boundary, where an unfloored signing time would overstate by ~1s. */
    jest.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 1000) * 1000 + 999);
    try {
      const { url, expiresAt } = await getS3DownloadURL({
        file: fileFor('uploads/user1/a.txt'),
        expiresIn: 900,
      });
      const parsed = new URL(url);
      const signedExpiry =
        parseAmzDate(parsed.searchParams.get('X-Amz-Date') as string) +
        Number(parsed.searchParams.get('X-Amz-Expires')) * 1000;

      expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(expiresAt.getTime()).toBeLessThanOrEqual(signedExpiry);
      expect(signedExpiry - expiresAt.getTime()).toBeLessThan(1000);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('reports the credential expiry when temporary credentials expire first', async () => {
    const before = Date.now();
    const { url, expiresAt } = await withTemporaryCredentials(120_000, () =>
      getS3DownloadURL({ file: fileFor('uploads/user1/a.txt'), expiresIn: 900 }),
    );

    expect(new URL(url).searchParams.get('X-Amz-Security-Token')).toBe('session-token');
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(121_000);
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(120_000);
  });

  it('keeps the requested expiry when temporary credentials outlive it', async () => {
    const before = Date.now();
    const { expiresAt } = await withTemporaryCredentials(3_600_000, () =>
      getS3DownloadURL({ file: fileFor('uploads/user1/a.txt'), expiresIn: 300 }),
    );

    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(300_000);
    expect(expiresAt.getTime() - before).toBeGreaterThan(298_000);
  });
});
