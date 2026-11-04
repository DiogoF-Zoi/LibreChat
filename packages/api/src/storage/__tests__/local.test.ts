import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
  moveLocalFile,
  writeLocalFile,
  saveLocalBuffer,
  writeFileAtomic,
  resolveLocalDownloadPath,
} from '../local';

describe('resolveLocalDownloadPath', () => {
  let base: string;
  let roots: { uploads: string; imageOutput: string };
  let outside: string;

  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-download-')));
    roots = { uploads: path.join(base, 'uploads'), imageOutput: path.join(base, 'images') };
    outside = path.join(base, 'outside');
    await Promise.all(
      [roots.uploads, roots.imageOutput, outside].map((dir) =>
        fs.mkdir(path.join(dir, 'user-1'), { recursive: true }),
      ),
    );
    await fs.writeFile(path.join(roots.uploads, 'user-1', 'report.xlsx'), 'upload');
    await fs.writeFile(path.join(roots.imageOutput, 'user-1', 'chart.png'), 'image');
    await fs.writeFile(path.join(outside, 'user-1', 'secret.txt'), 'secret');
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('resolves an upload to its real path with the stats a validator needs', async () => {
    const result = await resolveLocalDownloadPath('/uploads/user-1/report.xlsx', roots);

    expect(result).toEqual({
      ok: true,
      value: {
        path: path.join(roots.uploads, 'user-1', 'report.xlsx'),
        size: 6,
        mtimeMs: expect.any(Number),
      },
    });
  });

  it('resolves an image under the image root, ignoring a cache-busting suffix', async () => {
    const result = await resolveLocalDownloadPath('/images/user-1/chart.png?v=123', roots);
    expect(result.ok && result.value.path).toBe(
      path.join(roots.imageOutput, 'user-1', 'chart.png'),
    );
  });

  it.each([
    ['an unknown root', '/outside/user-1/secret.txt'],
    ['an absolute path', path.resolve('/srv/outside/secret.txt')],
    ['a prefix that is not at the start', '/x/uploads/user-1/report.xlsx'],
    ['a relative traversal', '/uploads/../outside/user-1/secret.txt'],
    ['a nested traversal', '/uploads/user-1/../../outside/user-1/secret.txt'],
    ['an encoded-looking traversal kept literal', '/uploads/..%2Foutside/secret.txt'],
    ['a null byte', '/uploads/user-1/report.xlsx\0.png'],
    ['the root itself', '/uploads/'],
  ])('refuses %s', async (_label, filepath) => {
    expect((await resolveLocalDownloadPath(filepath, roots)).ok).toBe(false);
  });

  it.each([
    ['/uploads/../outside/user-1/secret.txt'],
    ['/uploads/user-1/../../outside/user-1/secret.txt'],
    ['/uploads/user-1/report.xlsx\0.png'],
  ])('reports %s as outside storage', async (filepath) => {
    expect(await resolveLocalDownloadPath(filepath, roots)).toEqual({
      ok: false,
      error: { code: 'outside_storage' },
    });
  });

  it('refuses a symlink inside a root that points outside it', async () => {
    await fs.symlink(
      path.join(outside, 'user-1'),
      path.join(roots.uploads, 'user-1', 'escape'),
      'junction',
    );

    expect(await resolveLocalDownloadPath('/uploads/user-1/escape/secret.txt', roots)).toEqual({
      ok: false,
      error: { code: 'outside_storage' },
    });
  });

  it('follows a symlink that stays inside its root', async () => {
    await fs.mkdir(path.join(roots.uploads, 'shared'));
    await fs.writeFile(path.join(roots.uploads, 'shared', 'data.csv'), 'a,b');
    await fs.symlink(
      path.join(roots.uploads, 'shared'),
      path.join(roots.uploads, 'user-1', 'link'),
      'junction',
    );

    const result = await resolveLocalDownloadPath('/uploads/user-1/link/data.csv', roots);
    expect(result.ok && result.value.path).toBe(path.join(roots.uploads, 'shared', 'data.csv'));
  });

  it.each([
    ['a missing file', '/uploads/user-1/gone.xlsx'],
    ['a missing directory', '/uploads/user-9/gone.xlsx'],
    ['a directory', '/uploads/user-1'],
    ['a path through a file', '/uploads/user-1/report.xlsx/inner'],
  ])('reports %s as not found', async (_label, filepath) => {
    expect(await resolveLocalDownloadPath(filepath, roots)).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('reports a missing storage root as not found', async () => {
    await fs.rm(roots.uploads, { recursive: true });
    expect(await resolveLocalDownloadPath('/uploads/user-1/report.xlsx', roots)).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('local storage writes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-storage-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves one whole payload when writers of different sizes race on one path', async () => {
    const target = path.join(dir, 'avatar.png');
    const large = Buffer.alloc(4 * 1024 * 1024, 'a');
    const small = Buffer.alloc(1024, 'b');

    await Promise.all([writeFileAtomic(target, large), writeFileAtomic(target, small)]);

    const written = await fs.readFile(target);
    expect(written.equals(large) || written.equals(small)).toBe(true);
    expect(await fs.readdir(dir)).toEqual(['avatar.png']);
  });

  it('removes its temp file and rethrows when the rename fails', async () => {
    const target = path.join(dir, 'occupied');
    await fs.mkdir(path.join(target, 'child'), { recursive: true });

    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(['occupied']);
  });

  it('saves a buffer under the user directory and returns its URL path', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };

    const images = await saveLocalBuffer({
      paths,
      userId: 'user1',
      buffer: Buffer.from('png'),
      fileName: 'a.png',
    });
    const uploads = await saveLocalBuffer({
      paths,
      userId: 'user1',
      buffer: Buffer.from('doc'),
      fileName: 'b.txt',
      basePath: 'uploads',
    });

    expect(images).toBe('/images/user1/a.png');
    expect(uploads).toBe('/uploads/user1/b.txt');
    expect(await fs.readFile(path.join(paths.publicPath, 'images', 'user1', 'a.png'), 'utf8')).toBe(
      'png',
    );
    expect(await fs.readFile(path.join(paths.uploads, 'user1', 'b.txt'), 'utf8')).toBe('doc');
  });

  it('rejects a traversing file name without creating any directory', async () => {
    const paths = { publicPath: path.join(dir, 'public'), uploads: path.join(dir, 'uploads') };

    await expect(
      saveLocalBuffer({ paths, userId: 'user1', buffer: Buffer.from('x'), fileName: '../x' }),
    ).rejects.toThrow('Path traversal detected in filename');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('leaves one whole file when two uploads move to one path at once', async () => {
    const large = path.join(dir, 'large.tmp');
    const small = path.join(dir, 'small.tmp');
    const largeData = Buffer.alloc(4 * 1024 * 1024, 'a');
    const smallData = Buffer.alloc(1024, 'b');
    await fs.writeFile(large, largeData);
    await fs.writeFile(small, smallData);

    const out = path.join(dir, 'out');
    await Promise.all([
      moveLocalFile(large, out, 'image.png'),
      moveLocalFile(small, out, 'image.png'),
    ]);

    const written = await fs.readFile(path.join(out, 'image.png'));
    expect(written.equals(largeData) || written.equals(smallData)).toBe(true);
    expect(await fs.readdir(out)).toEqual(['image.png']);
  });

  it('rejects a traversing name in the write and move helpers', async () => {
    const source = path.join(dir, 'upload.tmp');
    await fs.writeFile(source, 'content');
    const target = path.join(dir, 'target');

    await expect(writeLocalFile(target, '../escaped', 'x')).rejects.toThrow(
      'Path traversal detected in filename',
    );
    await expect(moveLocalFile(source, target, '../escaped')).rejects.toThrow(
      'Path traversal detected in filename',
    );
    expect(await fs.readdir(dir)).toEqual(['upload.tmp']);
  });

  it('writes and moves to a name near NAME_MAX', async () => {
    const longName = `${'n'.repeat(250)}.png`;
    const source = path.join(dir, 'upload.tmp');
    await fs.writeFile(source, 'moved');

    await writeLocalFile(path.join(dir, 'written'), longName, 'written');
    await moveLocalFile(source, path.join(dir, 'moved'), longName);

    expect(await fs.readFile(path.join(dir, 'written', longName), 'utf8')).toBe('written');
    expect(await fs.readFile(path.join(dir, 'moved', longName), 'utf8')).toBe('moved');
    expect(await fs.readdir(path.join(dir, 'moved'))).toEqual([longName]);
  });

  it('moves a temp upload into a new directory', async () => {
    const source = path.join(dir, 'upload.tmp');
    await fs.writeFile(source, 'content');

    const target = await moveLocalFile(source, path.join(dir, 'out', 'user1'), 'file.txt');

    expect(target).toBe(path.join(dir, 'out', 'user1', 'file.txt'));
    expect(await fs.readFile(target, 'utf8')).toBe('content');
    await expect(fs.access(source)).rejects.toThrow();
  });
});
