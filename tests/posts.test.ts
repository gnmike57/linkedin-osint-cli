import { describe, expect, it, vi, afterEach } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageFilename, uploadImage } from '../src/commands/posts/create.js';

describe('imageFilename', () => {
  it('uses a bare basename for Windows-style paths', () => {
    expect(imageFilename('C:\\tmp\\photos\\photo.png')).toBe('photo.png');
  });

  it('uses a bare basename for POSIX-style paths', () => {
    expect(imageFilename('/tmp/photos/photo.jpg')).toBe('photo.jpg');
  });
});

describe('uploadImage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockClient(uploadUrl: string) {
    return {
      post: async () => ({
        data: { value: { singleUploadUrl: uploadUrl, urn: 'urn:li:media:1' } },
      }),
    } as never;
  }

  async function withTempImage(fn: (path: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'posts-test-'));
    const file = join(dir, 'photo.png');
    await writeFile(file, Buffer.from('fakepng'));
    try {
      await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('sends the upload metadata with the basename (not the full path)', async () => {
    let capturedFilename = '';
    const client = {
      post: async (_path: string, body: any) => {
        capturedFilename = body.filename;
        return { data: { value: { singleUploadUrl: 'https://linkedin.example/upload', urn: 'urn:li:media:9' } } };
      },
    } as never;
    globalThis.fetch = (async () => ({ ok: true }) as Response) as typeof fetch;
    await withTempImage(async (path) => {
      const dirName = path.split(/[\\/]/).slice(0, -1).join('/');
      const urn = await uploadImage(client, join(dirName, 'photo.png'));
      expect(urn).toBe('urn:li:media:9');
      expect(capturedFilename).toBe('photo.png');
    });
  });

  it('rejects non-https upload URLs before sending the file', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await withTempImage(async (path) => {
      await expect(uploadImage(mockClient('http://evil.example/upload'), path)).rejects.toThrow(
        /https/i,
      );
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
