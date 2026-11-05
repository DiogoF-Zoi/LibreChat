const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { FileSources } = require('librechat-data-provider');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, tenantStorage } = require('@librechat/data-schemas');

const mockUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-route-'));

jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: jest.fn(async () => ({
    paths: { uploads: mockUploads, imageOutput: mockUploads },
  })),
}));

const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { createFile } = require('~/models');
const signedRouter = require('./signed');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

const binaryParser = (res, done) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('GET /api/files/signed/:id (local storage)', () => {
  let app;
  let mongoServer;
  const originalEnv = {
    DOMAIN_SERVER: process.env.DOMAIN_SERVER,
    TENANT_ISOLATION_STRICT: process.env.TENANT_ISOLATION_STRICT,
  };

  beforeAll(async () => {
    process.env.DOMAIN_SERVER = 'https://chat.example.com/librechat';
    /** The caller has no tenant context, so the lookup must work when missing context fails closed. */
    process.env.TENANT_ISOLATION_STRICT = 'true';

    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Object.assign(mongoose.models, createModels(mongoose));

    app = express();
    app.use('/api/files/signed', signedRouter);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
    fs.rmSync(mockUploads, { recursive: true, force: true });
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  async function storeLocalFile({ tenantId = 'tenant-a', bytes = 256 * 1024 } = {}) {
    const userId = new mongoose.Types.ObjectId().toString();
    const file_id = uuidv4();
    const storedName = `${file_id}__report.pdf`;
    const content = crypto.randomBytes(bytes);
    fs.mkdirSync(path.join(mockUploads, userId), { recursive: true });
    fs.writeFileSync(path.join(mockUploads, userId, storedName), content);

    const record = await tenantStorage.run({ tenantId }, async () =>
      createFile({
        user: userId,
        file_id,
        filename: 'report.pdf',
        filepath: `/uploads/${userId}/${storedName}`,
        bytes,
        type: 'application/pdf',
        source: FileSources.local,
      }),
    );
    return { record, content, userId, storedName };
  }

  async function issueURL(record, expiresIn = 300) {
    const { getDownloadURL } = getStrategyFunctions(FileSources.local);
    const { url, expiresAt } = await getDownloadURL({ file: record, expiresIn });
    return { url: new URL(url), expiresAt };
  }

  const routePath = (url) => `${url.pathname.replace(/^\/librechat/, '')}${url.search}`;

  it('issues a proxy URL that names the record, not the stored path', async () => {
    const { record, userId, storedName } = await storeLocalFile();

    const { url, expiresAt } = await issueURL(record, 120);

    expect(url.origin).toBe('https://chat.example.com');
    expect(url.pathname).toBe(`/librechat/api/files/signed/${record._id}`);
    expect(url.toString()).not.toContain(userId);
    expect(url.toString()).not.toContain(storedName);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(115_000);
  });

  it('streams the original bytes of a tenant file to an unauthenticated caller', async () => {
    const { record, content } = await storeLocalFile({ bytes: 8 * 1024 * 1024 + 7 });
    const { url } = await issueURL(record);

    const response = await request(app).get(routePath(url)).buffer(true).parse(binaryParser);

    expect(response.status).toBe(200);
    expect(response.body.length).toBe(content.length);
    expect(sha256(response.body)).toBe(sha256(content));
    expect(response.headers['content-disposition']).toContain('report.pdf');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('lets a consumer probe with HEAD and resume with a byte range', async () => {
    const { record, content } = await storeLocalFile({ bytes: 1024 * 1024 });
    const { url } = await issueURL(record);

    const head = await request(app).head(routePath(url));
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(content.length));
    expect(head.headers['accept-ranges']).toBe('bytes');

    const tail = await request(app)
      .get(routePath(url))
      .set('Range', `bytes=${content.length - 4096}-`)
      .set('If-Range', head.headers.etag)
      .buffer(true)
      .parse(binaryParser);
    expect(tail.status).toBe(206);
    expect(sha256(tail.body)).toBe(sha256(content.subarray(content.length - 4096)));
  });

  it('rejects a URL moved onto another record', async () => {
    const first = await storeLocalFile();
    const second = await storeLocalFile({ tenantId: 'tenant-b' });
    const { url } = await issueURL(first.record);

    const moved = routePath(url).replace(String(first.record._id), String(second.record._id));
    const response = await request(app).get(moved);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('invalid_url');
  });

  it('returns 404 once the record is deleted', async () => {
    const { record } = await storeLocalFile();
    const { url } = await issueURL(record);
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      mongoose.models.File.deleteOne({ _id: record._id }),
    );

    const response = await request(app).get(routePath(url));

    expect(response.status).toBe(404);
  });
});
