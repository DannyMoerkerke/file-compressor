import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as unzipper from 'unzipper';

async function loadFileCompressor(page) {
  const srcPath = path.resolve('src/FileCompressor.js');
  const code = await fs.readFile(srcPath, 'utf8');
  const patched = code.replace('export class FileCompressor', 'class FileCompressor');
  const script = `${patched}\nwindow.FileCompressor = FileCompressor;`;
  await page.addScriptTag({ content: script });
}

test.describe('FileCompressor', () => {
  test('compresses a single file using deflate and is round-trippable', async ({ page }) => {
    await page.goto('about:blank');
    await loadFileCompressor(page);

    const result = await page.evaluate(async () => {
      const text = 'hello playwright';
      const file = new File([text], 'hello.txt', { type: 'text/plain' });
      const compressor = new window.FileCompressor();
      const compressed = await compressor.compress(file);

      const stream = compressed.stream().pipeThrough(new DecompressionStream('deflate'));
      const reader = stream.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const buffer = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      const decoded = new TextDecoder().decode(buffer);
      return {
        type: compressed.type,
        decoded,
        compressedSize: compressed.size,
      };
    });

    expect(result.type).toBe('');
    expect(result.compressedSize).toBeGreaterThan(0);
    expect(result.decoded).toBe('hello playwright');
  });

  test('creates a zip archive that extracts to the original files', async ({ page }) => {
    await page.goto('about:blank');
    await loadFileCompressor(page);

    const data = await page.evaluate(async () => {
      const files = [
        new File(['alpha'], 'alpha.txt', { type: 'text/plain' }),
        new File(['bravo'], 'bravo.txt', { type: 'text/plain' }),
      ];
      const compressor = new window.FileCompressor();
      const zipBlob = await compressor.compress(files);
      const zipBytes = Array.from(new Uint8Array(await zipBlob.arrayBuffer()));

      return {
        zipType: zipBlob.type,
        zipBytes,
      };
    });

    expect(data.zipType).toBe('application/zip');

    const tmpRoot = path.join(process.cwd(), 'tmp');
    await fs.mkdir(tmpRoot, { recursive: true });
    const outputDir = await fs.mkdtemp(path.join(tmpRoot, 'zip-test-'));
    const zipPath = path.join(outputDir, 'archive.zip');
    const extractDir = path.join(outputDir, 'unzipped');
    await fs.mkdir(extractDir, { recursive: true });
    await fs.writeFile(zipPath, Buffer.from(data.zipBytes));

    const directory = await unzipper.Open.file(zipPath);
    await directory.extract({ path: extractDir });

    const extracted = await fs.readdir(extractDir);
    expect(extracted.sort()).toEqual(['alpha.txt', 'bravo.txt']);
    await expect(fs.readFile(path.join(extractDir, 'alpha.txt'), 'utf8')).resolves.toBe('alpha');
    await expect(fs.readFile(path.join(extractDir, 'bravo.txt'), 'utf8')).resolves.toBe('bravo');
  });
});
