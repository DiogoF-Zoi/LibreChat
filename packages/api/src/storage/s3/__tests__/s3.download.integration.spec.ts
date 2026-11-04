/**
 * Presigned download URL integration tests.
 *
 * Runs against a real S3 bucket or any S3-compatible endpoint (MinIO, R2, s3rver).
 * Skipped when AWS_TEST_BUCKET_NAME is not set.
 *
 *   AWS_TEST_BUCKET_NAME=my-bucket AWS_REGION=us-east-1 \
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   [AWS_ENDPOINT_URL=http://localhost:4568 AWS_FORCE_PATH_STYLE=true] \
 *   npx jest s3.download.integration
 *
 * The URL is always fetched without credentials, as an external consumer would.
 */
import { Readable } from 'stream';
import { createHash, randomBytes } from 'crypto';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { TFile } from 'librechat-data-provider';
import type { S3Client } from '@aws-sdk/client-s3';

const TEST_BUCKET = process.env.AWS_TEST_BUCKET_NAME;
const RUN_ID = `download-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BODY = Buffer.from('presigned-download-payload');

describe('S3 presigned download URL (integration)', () => {
  if (!TEST_BUCKET) {
    // eslint-disable-next-line jest/expect-expect
    it.skip('Skipped: AWS_TEST_BUCKET_NAME not configured', () => {});
    return;
  }

  let originalEnv: NodeJS.ProcessEnv;
  let s3: S3Client;
  let getS3DownloadURL: typeof import('../crud').getS3DownloadURL;
  const keys: string[] = [];

  const putObject = async (key: string, contentType = 'text/plain', body: Buffer = BODY) => {
    keys.push(key);
    await s3.send(
      new PutObjectCommand({ Bucket: TEST_BUCKET, Key: key, Body: body, ContentType: contentType }),
    );
    return { storageKey: key, filepath: '', filename: key } as TFile;
  };

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.AWS_BUCKET_NAME = TEST_BUCKET;
    process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
    jest.resetModules();
    const { initializeS3 } = await import('~/cdn/s3');
    s3 = initializeS3() as S3Client;
    ({ getS3DownloadURL } = await import('../crud'));
  }, 300_000);

  afterAll(async () => {
    await Promise.all(
      keys.map((Key) =>
        s3.send(new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key })).catch(() => {}),
      ),
    );
    process.env = originalEnv;
  });

  it('serves the object to an unauthenticated consumer', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/report.txt`);
    const { url } = await getS3DownloadURL({ file, customFilename: 'report.txt' });

    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BODY)).toBe(true);
  });

  it('streams a large file with a matching SHA-256 checksum', async () => {
    const chunks = Array.from({ length: 50 }, () => randomBytes(1024 * 1024));
    const large = Buffer.concat(chunks);
    const expected = createHash('sha256').update(large).digest('hex');
    const file = await putObject(
      `${RUN_ID}/uploads/user1/large.bin`,
      'application/octet-stream',
      large,
    );
    const { url } = await getS3DownloadURL({ file });

    const res = await fetch(url);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of Readable.fromWeb(res.body as never)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }

    expect(res.status).toBe(200);
    expect(size).toBe(large.length);
    expect(hash.digest('hex')).toBe(expected);
  }, 120_000);

  it('serves keys containing spaces, plus signs and unicode', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/relatório (1)+final 日本語.txt`);
    const { url } = await getS3DownloadURL({ file });

    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BODY)).toBe(true);
  });

  it('forces a download with the stored type and an RFC 5987 filename', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/page.bin`, 'text/html');
    const { url } = await getS3DownloadURL({
      file,
      customFilename: 'relatório "final"; 日本語.xlsx',
      contentType: 'text/html',
    });

    const res = await fetch(url);
    await res.arrayBuffer();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const disposition = res.headers.get('content-disposition') as string;
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    expect(disposition).toContain(
      `filename*=UTF-8''relat%C3%B3rio%20%22final%22%3B%20%E6%97%A5%E6%9C%AC%E8%AA%9E.xlsx`,
    );
  });

  it.each([undefined, ''])('still forces a download when the filename is %p', async (name) => {
    const file = await putObject(`${RUN_ID}/uploads/user1/nofilename.html`, 'text/html');
    const { url } = await getS3DownloadURL({
      file,
      customFilename: name,
      contentType: 'text/html',
    });

    const res = await fetch(url);
    await res.arrayBuffer();

    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`,
    );
  });

  it('serves a byte range straight from S3', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/range.txt`);
    const { url } = await getS3DownloadURL({ file });

    const res = await fetch(url, { headers: { Range: 'bytes=10-19' } });

    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(BODY.subarray(10, 20))).toBe(true);
  });

  it('reports an expiresAt no later than the moment S3 stops honouring the URL', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/boundary.txt`);
    const { url, expiresAt } = await getS3DownloadURL({ file, expiresIn: 3 });

    await new Promise((resolve) => setTimeout(resolve, expiresAt.getTime() - Date.now() + 1500));

    expect((await fetch(url)).status).toBe(403);
  }, 30_000);

  it('rejects a URL whose signature was altered', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/tamper-sig.txt`);
    const { url } = await getS3DownloadURL({ file });
    const parsed = new URL(url);
    const signature = parsed.searchParams.get('X-Amz-Signature') as string;
    parsed.searchParams.set(
      'X-Amz-Signature',
      `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`,
    );

    const res = await fetch(parsed);

    expect(res.status).toBe(403);
  });

  it('rejects a signature reused against a different object key', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/mine.txt`);
    await putObject(`${RUN_ID}/uploads/user2/theirs.txt`);
    const { url } = await getS3DownloadURL({ file });
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace('user1/mine.txt', 'user2/theirs.txt');

    const res = await fetch(parsed);

    expect(res.status).toBe(403);
  });

  it('rejects write attempts with a read-only URL', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/readonly.txt`);
    const { url } = await getS3DownloadURL({ file });

    const res = await fetch(url, { method: 'PUT', body: 'overwrite' });

    expect(res.status).toBe(403);
  });

  it('rejects the URL after it expires', async () => {
    const file = await putObject(`${RUN_ID}/uploads/user1/expiring.txt`);
    const { url, expiresAt } = await getS3DownloadURL({ file, expiresIn: 1 });

    expect((await fetch(url)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, expiresAt.getTime() - Date.now() + 2000));

    expect((await fetch(url)).status).toBe(403);
  }, 30_000);
});
