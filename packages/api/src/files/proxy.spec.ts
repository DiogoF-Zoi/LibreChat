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
import type { ServerRequest } from '~/types/http';
import { createSignedDownloadHandler } from './proxy';
import { getSignedDownloadURL } from './signed';

const secret = 'c'.repeat(64);
const id = '507f1f77bcf86cd799439011';

const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** Flips the first signature character to a different valid one. */
const alterSignature = (url: string) =>
  url.replace(/signature=(.)/, (_match, first: string) => `signature=${first === 'A' ? 'B' : 'A'}`);

describe('createSignedDownloadHandler', () => {
  let uploads: string;
  let file: SignedDownloadFile;
  let content: Buffer;
  let openLocalStream: jest.Mock<Promise<Readable>, [ServerRequest, string]>;
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

  beforeAll(() => {
    uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-download-'));
    fs.mkdirSync(path.join(uploads, 'user-1'));
  });

  afterAll(() => {
    fs.rmSync(uploads, { recursive: true, force: true });
  });

  beforeEach(() => {
    content = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(path.join(uploads, 'user-1', 'file-1__report.pdf'), content);
    file = {
      _id: id,
      file_id: 'file-1',
      filename: 'report.pdf',
      filepath: '/uploads/user-1/file-1__report.pdf',
      source: FileSources.local,
    };
    openLocalStream = jest.fn(async (req: ServerRequest, filepath: string) =>
      fs.createReadStream(
        path.join(req.config?.paths?.uploads ?? '', filepath.replace(/^\/uploads\//, '')),
      ),
    );
    deps = {
      getSecret: jest.fn(() => secret),
      getFiles: jest.fn(async (_filter: { _id: string }) => [file]),
      getAppConfig: jest.fn(
        async (_options: GetAppConfigOptions) => ({ paths: { uploads } }) as unknown as AppConfig,
      ),
      getStrategyFunctions: jest.fn((_source: string) => ({ getDownloadStream: openLocalStream })),
      getContentDisposition: jest.fn((name: string) => `attachment; filename="${name}"`),
    };
    app = express();
    app.get('/api/files/signed/:id', createSignedDownloadHandler(deps));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('streams the original bytes without a session', async () => {
    const response = await request(app)
      .get(await signedPath())
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(sha256(response.body as Buffer)).toBe(sha256(content));
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe('attachment; filename="report.pdf"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(deps.getFiles).toHaveBeenCalledWith({ _id: id });
    expect(deps.getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(openLocalStream).toHaveBeenCalledWith(expect.anything(), file.filepath);
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
      expect(deps.getStrategyFunctions).not.toHaveBeenCalled();
    },
  );

  it('treats a record without a source as local', async () => {
    file = { ...file, source: undefined };
    const response = await request(app).get(await signedPath());
    expect(response.status).toBe(200);
  });

  it('returns 404 when the stored bytes are gone', async () => {
    fs.rmSync(path.join(uploads, 'user-1', 'file-1__report.pdf'));
    const response = await request(app).get(await signedPath());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not Found', code: 'file_not_found' });
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('fails closed when no signing secret is configured', async () => {
    const target = await signedPath();
    deps.getSecret.mockReturnValue(undefined);

    const response = await request(app).get(target);

    expect(response.status).toBe(500);
    expect(deps.getFiles).not.toHaveBeenCalled();
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

  it('releases the source when the client disconnects mid-download', async () => {
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
    deps.getStrategyFunctions.mockReturnValue({ getDownloadStream: async () => endless });

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
