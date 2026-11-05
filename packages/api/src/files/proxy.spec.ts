import fs from 'fs';
import os from 'os';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import { FileSources } from 'librechat-data-provider';
import { logger, getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { TFile } from 'librechat-data-provider';
import type { AddressInfo } from 'net';
import type { SignedDownloadFile, SignedDownloadHandlerDeps } from './proxy';
import type { GetAppConfigOptions } from '~/app/service';
import { createSignedDownloadHandler } from './proxy';
import { getSignedDownloadURL } from './signed';

const secret = 'c'.repeat(64);
const id = '507f1f77bcf86cd799439011';

const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** Flips the first signature character to a different valid one. */
const alterSignature = (url: string) =>
  url.replace(/signature=(.)/, (_match, first: string) => `signature=${first === 'A' ? 'B' : 'A'}`);

const binaryParser = (res: request.Response, done: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('createSignedDownloadHandler', () => {
  let base: string;
  let uploads: string;
  let storedPath: string;
  let file: SignedDownloadFile;
  let content: Buffer;
  let deps: jest.Mocked<SignedDownloadHandlerDeps>;
  let app: express.Express;

  async function signedPath(target: SignedDownloadFile = file, expiresIn = 300) {
    const { url } = await getSignedDownloadURL({
      file: { _id: target._id?.toString() } as TFile,
      secret,
      baseURL: 'https://chat.example.com',
      expiresIn,
    });
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }

  const download = async (target?: string) =>
    request(app)
      .get(target ?? (await signedPath()))
      .buffer(true)
      .parse(binaryParser);

  beforeAll(() => {
    /** The native resolver, as the handler uses; it also expands Windows 8.3 short names. */
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'signed-download-')));
    uploads = path.join(base, 'uploads');
    fs.mkdirSync(path.join(uploads, 'user-1'), { recursive: true });
    fs.mkdirSync(path.join(base, 'images'));
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret');
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    content = crypto.randomBytes(64 * 1024);
    storedPath = path.join(uploads, 'user-1', 'file-1__report.pdf');
    fs.writeFileSync(storedPath, content);
    file = {
      _id: id,
      file_id: 'file-1',
      filename: 'report.pdf',
      filepath: '/uploads/user-1/file-1__report.pdf',
      source: FileSources.local,
    };
    deps = {
      getSecret: jest.fn(() => secret),
      getFiles: jest.fn(async (_filter: { _id: string }) => [file]),
      getAppConfig: jest.fn(
        async (_options: GetAppConfigOptions) =>
          ({ paths: { uploads, imageOutput: path.join(base, 'images') } }) as unknown as AppConfig,
      ),
      getContentDisposition: jest.fn((name: string) => `attachment; filename="${name}"`),
    };
    app = express();
    app.get('/api/files/signed/:id', createSignedDownloadHandler(deps));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('streams the original bytes from disk without a session', async () => {
    const readStream = jest.spyOn(fs, 'createReadStream');

    const response = await download();

    expect(response.status).toBe(200);
    expect(sha256(response.body as Buffer)).toBe(sha256(content));
    expect(response.headers['content-length']).toBe(String(content.length));
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe('attachment; filename="report.pdf"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['etag']).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers['last-modified']).toBeTruthy();
    expect(readStream).toHaveBeenCalledWith(storedPath, expect.anything());
    expect(deps.getFiles).toHaveBeenCalledWith({ _id: id });
    expect(deps.getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('serves a single byte range', async () => {
    const response = await request(app)
      .get(await signedPath())
      .set('Range', 'bytes=100-199')
      .buffer(true)
      .parse(binaryParser);

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 100-199/${content.length}`);
    expect(response.headers['content-length']).toBe('100');
    expect(sha256(response.body as Buffer)).toBe(sha256(content.subarray(100, 200)));
  });

  it('serves a suffix range', async () => {
    const response = await request(app)
      .get(await signedPath())
      .set('Range', 'bytes=-10')
      .buffer(true)
      .parse(binaryParser);

    expect(response.status).toBe(206);
    expect(sha256(response.body as Buffer)).toBe(sha256(content.subarray(-10)));
  });

  it('answers an unsatisfiable range with 416 and the full length', async () => {
    const response = await request(app)
      .get(await signedPath())
      .set('Range', `bytes=${content.length + 1}-`);

    expect(response.status).toBe(416);
    expect(response.headers['content-range']).toBe(`bytes */${content.length}`);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('resumes with If-Range only while the bytes are unchanged', async () => {
    const target = await signedPath();
    const { headers } = await request(app).head(target);

    const resumed = await request(app)
      .get(target)
      .set('Range', 'bytes=10-')
      .set('If-Range', headers['etag'])
      .buffer(true)
      .parse(binaryParser);
    expect(resumed.status).toBe(206);

    fs.writeFileSync(storedPath, crypto.randomBytes(content.length + 1));
    const replaced = await request(app)
      .get(target)
      .set('Range', 'bytes=10-')
      .set('If-Range', headers['etag'])
      .buffer(true)
      .parse(binaryParser);
    expect(replaced.status).toBe(200);
    expect((replaced.body as Buffer).length).toBe(content.length + 1);
  });

  it('answers HEAD with the headers and no body', async () => {
    const response = await request(app).head(await signedPath());

    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(String(content.length));
    expect(response.headers['content-disposition']).toBe('attachment; filename="report.pdf"');
    expect(response.body).toEqual({});
  });

  it('serves a zero-byte file', async () => {
    fs.writeFileSync(storedPath, Buffer.alloc(0));

    const response = await download();

    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe('0');
    expect((response.body as Buffer).length).toBe(0);
  });

  it('serves concurrent downloads of one URL independently', async () => {
    const target = await signedPath();

    const responses = await Promise.all(Array.from({ length: 8 }, () => download(target)));

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(sha256(response.body as Buffer)).toBe(sha256(content));
    }
  });

  it('looks the record up in the system tenant context', async () => {
    let tenantDuringLookup: string | undefined;
    deps.getFiles.mockImplementation(async () => {
      tenantDuringLookup = getTenantId();
      return [file];
    });

    await request(app).get(await signedPath());

    expect(tenantDuringLookup).toBe(SYSTEM_TENANT_ID);
  });

  it('reports an expired URL without touching the database', async () => {
    const realNow = Date.now;
    const target = await signedPath(file, 60);
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);

    const response = await request(app).get(target);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden', code: 'expired_url' });
    expect(deps.getFiles).not.toHaveBeenCalled();
  });

  it.each([
    ['altered signature', alterSignature],
    [
      'altered expiry',
      (url: string) => url.replace(/expires=(\d+)/, (_m, e) => `expires=${+e + 1}`),
    ],
    ['another record', (url: string) => url.replace(id, '507f1f77bcf86cd799439012')],
    ['missing signature', (url: string) => url.replace(/&signature=[^&]+/, '')],
    ['repeated signature', (url: string) => `${url}&signature=again`],
    ['malformed id', (url: string) => url.replace(id, 'not-an-id')],
  ])('rejects an %s before any lookup', async (_label, mutate) => {
    const response = await request(app).get(mutate(await signedPath()));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden', code: 'invalid_url' });
    expect(deps.getFiles).not.toHaveBeenCalled();
  });

  it('returns 404 when the record no longer exists', async () => {
    deps.getFiles.mockResolvedValue([]);
    const response = await request(app).get(await signedPath());
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not Found', code: 'file_not_found' });
  });

  it.each([FileSources.s3, FileSources.text, FileSources.openai])(
    'does not serve a %s record through the proxy',
    async (source) => {
      file = { ...file, source };
      const response = await request(app).get(await signedPath());

      expect(response.status).toBe(404);
      expect(deps.getAppConfig).not.toHaveBeenCalled();
    },
  );

  it('treats a record without a source as local', async () => {
    file = { ...file, source: undefined };
    const response = await request(app).get(await signedPath());
    expect(response.status).toBe(200);
  });

  it('returns 404 when the stored bytes are gone', async () => {
    fs.rmSync(storedPath);
    const response = await request(app).get(await signedPath());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not Found', code: 'file_not_found' });
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it.each([
    ['under an unknown root', () => '/outside/secret.txt'],
    ['at an absolute path', () => path.join(base, 'outside', 'secret.txt')],
    ['behind a traversal out of uploads', () => '/uploads/../outside/secret.txt'],
  ])('never serves a record stored %s', async (_label, filepath) => {
    file = { ...file, filepath: filepath() };
    const warn = jest.spyOn(logger, 'warn');

    const response = await request(app).get(await signedPath());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not Found', code: 'file_not_found' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside the servable roots'));
  });

  it('fails closed when no signing secret is configured', async () => {
    const target = await signedPath();
    deps.getSecret.mockReturnValue(undefined);

    const response = await request(app).get(target);

    expect(response.status).toBe(500);
    expect(deps.getFiles).not.toHaveBeenCalled();
  });

  it('fails closed when storage paths are not configured', async () => {
    deps.getAppConfig.mockResolvedValue({} as AppConfig);

    const response = await request(app).get(await signedPath());

    expect(response.status).toBe(500);
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('never logs the signature or the request URL', async () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(logger, level),
    );
    const target = await signedPath();
    const signature = new URL(target, 'http://x').searchParams.get('signature')!;

    await request(app).get(alterSignature(target));
    await request(app).get(target);
    deps.getFiles.mockRejectedValueOnce(new Error(`lookup failed for ${target}`));
    await request(app).get(target);

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain(signature.slice(1));
    expect(logged).not.toContain('expires=');
  });

  it('releases the file stream when the client disconnects mid-download', async () => {
    let destroyed!: () => void;
    const sourceDestroyed = new Promise<void>((resolve) => (destroyed = resolve));
    const endless = new Readable({
      read() {
        this.push(Buffer.alloc(16 * 1024));
      },
      destroy(error, callback) {
        destroyed();
        callback(error);
      },
    });
    jest.spyOn(fs, 'createReadStream').mockReturnValueOnce(endless as unknown as fs.ReadStream);

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const target = await signedPath();
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ port, path: target }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ECONNRESET') {
            reject(error);
          }
        });
      });
      await expect(sourceDestroyed).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });
});
