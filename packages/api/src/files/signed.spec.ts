import crypto from 'node:crypto';
import { FileSources, MAX_DOWNLOAD_URL_EXPIRY_SECONDS } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { SignedDownloadInput } from './signed';
import { getSignedDownloadURL, verifySignedDownload, SIGNED_DOWNLOAD_PATH } from './signed';

const secret = 'a'.repeat(64);

const verify = (input: Omit<SignedDownloadInput, 'method'> & { method?: string }) =>
  verifySignedDownload({ method: 'GET', ...input });
const baseURL = 'https://chat.example.com';
const now = Date.parse('2026-11-02T10:00:00.000Z');
const id = '507f1f77bcf86cd799439011';

const file = {
  _id: id,
  file_id: 'file-1',
  filename: 'report.pdf',
  filepath: '/uploads/user-1/file-1__report.pdf',
  source: FileSources.local,
  type: 'application/pdf',
} as TFile;

async function issue(overrides: Partial<Parameters<typeof getSignedDownloadURL>[0]> = {}) {
  const result = await getSignedDownloadURL({ file, secret, baseURL, now, ...overrides });
  const url = new URL(result.url);
  return {
    ...result,
    url,
    id: url.pathname.split('/').pop(),
    expires: url.searchParams.get('expires'),
    signature: url.searchParams.get('signature'),
  };
}

describe('getSignedDownloadURL', () => {
  it('points at the proxy with the record id, never the stored path', async () => {
    const { url, id: urlId, expiresAt } = await issue({ expiresIn: 300 });

    expect(url.origin).toBe(baseURL);
    expect(url.pathname).toBe(`${SIGNED_DOWNLOAD_PATH}/${id}`);
    expect(urlId).toBe(id);
    expect(url.toString()).not.toContain('uploads');
    expect(url.toString()).not.toContain('report.pdf');
    expect(expiresAt).toEqual(new Date(now + 300_000));
    expect(url.searchParams.get('expires')).toBe(String(now / 1000 + 300));
  });

  it('defaults to the shared 300 second lifetime', async () => {
    const { expiresAt } = await issue();
    expect(expiresAt).toEqual(new Date(now + 300_000));
  });

  it('caps the lifetime at one hour', async () => {
    const { expiresAt } = await issue({ expiresIn: 7 * 24 * 3600 });
    expect(expiresAt).toEqual(new Date(now + MAX_DOWNLOAD_URL_EXPIRY_SECONDS * 1000));
  });

  it.each([
    ['https://chat.example.com/librechat', '/librechat/api/files/signed/'],
    ['https://chat.example.com/librechat/', '/librechat/api/files/signed/'],
    ['https://chat.example.com/', '/api/files/signed/'],
  ])('keeps the path prefix of %s', async (prefixedBaseURL, expectedPrefix) => {
    const { url } = await issue({ baseURL: prefixedBaseURL });
    expect(url.pathname).toBe(`${expectedPrefix}${id}`);
  });

  it('accepts an ObjectId-like record id', async () => {
    const objectId = { toString: () => id } as unknown as string;
    const { id: urlId } = await issue({ file: { ...file, _id: objectId } });
    expect(urlId).toBe(id);
  });

  it.each([
    ['secret', { secret: '' }, 'signing secret'],
    ['secret', { secret: undefined }, 'signing secret'],
    ['base URL', { baseURL: undefined }, 'public server URL'],
    ['record id', { file: { ...file, _id: undefined } }, 'no valid id'],
    ['record id', { file: { ...file, _id: '../etc/passwd' } }, 'no valid id'],
    ['expiry', { expiresIn: 0 }, 'positive whole number'],
    ['expiry', { expiresIn: 1.5 }, 'positive whole number'],
  ])('refuses to sign without a valid %s', async (_label, overrides, message) => {
    await expect(issue(overrides)).rejects.toThrow(message);
  });
});

describe('verifySignedDownload', () => {
  it('accepts a URL it issued until it expires', async () => {
    const { id: urlId, expires, signature } = await issue({ expiresIn: 60 });

    expect(verify({ secret, id: urlId, expires, signature, now })).toEqual({
      ok: true,
      value: { id },
    });
    expect(verify({ secret, id: urlId, expires, signature, now: now + 59_999 }).ok).toBe(true);
  });

  it('reports expiry once the lifetime has passed', async () => {
    const { id: urlId, expires, signature } = await issue({ expiresIn: 60 });

    expect(verify({ secret, id: urlId, expires, signature, now: now + 60_000 })).toEqual({
      ok: false,
      error: { code: 'expired_url' },
    });
  });

  it('rejects a signature from another secret', async () => {
    const { id: urlId, expires, signature } = await issue();
    const result = verify({
      secret: 'b'.repeat(64),
      id: urlId,
      expires,
      signature,
      now,
    });
    expect(result).toEqual({ ok: false, error: { code: 'invalid_url' } });
  });

  it('binds the signature to a read: HEAD is accepted, other methods are not', async () => {
    const { id: urlId, expires, signature } = await issue();

    expect(verify({ method: 'HEAD', secret, id: urlId, expires, signature, now }).ok).toBe(true);
    for (const method of ['POST', 'PUT', 'DELETE', 'get']) {
      expect(verify({ method, secret, id: urlId, expires, signature, now })).toEqual({
        ok: false,
        error: { code: 'invalid_url' },
      });
    }
  });

  it('never signs with the raw secret', async () => {
    const { id: urlId, expires, signature } = await issue();
    const rawKeySignatures = [`GET\n${urlId}\n${expires}`, `${urlId}:${expires}`].map((payload) =>
      crypto.createHmac('sha256', secret).update(payload).digest('base64url'),
    );

    expect(rawKeySignatures).not.toContain(signature);
  });

  it('rejects a signature moved onto another record', async () => {
    const { expires, signature } = await issue();
    const result = verify({
      secret,
      id: '507f1f77bcf86cd799439012',
      expires,
      signature,
      now,
    });
    expect(result).toEqual({ ok: false, error: { code: 'invalid_url' } });
  });

  it('rejects an extended expiry as invalid, not expired', async () => {
    const { id: urlId, expires, signature } = await issue();
    const extended = String(Number(expires) + 60);
    expect(verify({ secret, id: urlId, expires: extended, signature, now: now + 400_000 })).toEqual(
      { ok: false, error: { code: 'invalid_url' } },
    );
  });

  it('rejects a single altered signature character', async () => {
    const { id: urlId, expires, signature } = await issue();
    const last = signature!.slice(-1);
    const altered = `${signature!.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    expect(verify({ secret, id: urlId, expires, signature: altered, now }).ok).toBe(false);
  });

  it('rejects a correctly signed expiry beyond the lifetime cap', async () => {
    const signedLater = now + MAX_DOWNLOAD_URL_EXPIRY_SECONDS * 1000;
    const { id: urlId, expires, signature } = await issue({ now: signedLater, expiresIn: 300 });

    expect(verify({ secret, id: urlId, expires, signature, now })).toEqual({
      ok: false,
      error: { code: 'invalid_url' },
    });
    expect(verify({ secret, id: urlId, expires, signature, now: signedLater }).ok).toBe(true);
  });

  it.each([
    ['missing expiry', { expires: undefined }],
    ['missing signature', { signature: undefined }],
    ['array expiry', { expires: ['1', '2'] }],
    ['array signature', { signature: ['a', 'b'] }],
    ['non-numeric expiry', { expires: '17e9' }],
    ['negative expiry', { expires: '-1' }],
    ['short signature', { signature: 'abc' }],
    ['padded signature', { signature: `${'A'.repeat(43)}=` }],
    ['uppercase id', { id: id.toUpperCase() }],
    ['path traversal id', { id: '../../etc/passwd' }],
  ])('rejects a %s', async (_label, overrides) => {
    const issued = await issue();
    const result = verify({
      secret,
      id: issued.id,
      expires: issued.expires,
      signature: issued.signature,
      now,
      ...overrides,
    });
    expect(result).toEqual({ ok: false, error: { code: 'invalid_url' } });
  });
});
