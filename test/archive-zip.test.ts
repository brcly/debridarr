import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { ZipWriter, type ZipFileEntry } from '../src/archive/zip.js';
import { tmpDir } from './helpers.js';

const run = promisify(execFile);

// Node has no built-in zip reader, so Python's `zipfile` (stdlib, widely
// available) stands in as an independent, spec-compliant oracle for
// verifying this hand-rolled writer, including its always-ZIP64 records.
async function inspectWithPython(zipPath: string): Promise<{ names: string[]; sizes: Record<string, number>; contents: Record<string, string>; bad: string | null }> {
  const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
names = z.namelist()
print(json.dumps({
  "names": names,
  "sizes": {n: z.getinfo(n).file_size for n in names},
  "contents": {n: z.read(n).decode('utf8', 'replace') for n in names},
  "bad": bad,
}))
`;
  const { stdout } = await run('python3', ['-c', script, zipPath]);
  return JSON.parse(stdout);
}

async function buildZip(t: TestContext, files: { name: string; content: string; declaredSize?: number }[]): Promise<string> {
  const dir = await tmpDir(t, 'debridarr-zip');
  const chunks: Buffer[] = [];
  const out = new PassThrough();
  out.on('data', chunk => chunks.push(chunk as Buffer));
  const writer = new ZipWriter(out, new AbortController().signal);
  for (const [index, file] of files.entries()) {
    const path = join(dir, `f${index}`);
    await writeFile(path, file.content);
    const entry: ZipFileEntry = { name: file.name, size: file.declaredSize ?? Buffer.byteLength(file.content), open: () => open(path, 'r') };
    await writer.addFile(entry);
  }
  await writer.finish();
  const zipPath = join(dir, 'out.zip');
  await writeFile(zipPath, Buffer.concat(chunks));
  return zipPath;
}

test('produces a valid, always-ZIP64 archive that a spec-compliant reader can list and extract byte-exact', async t => {
  const files = [
    { name: 'Show/Season 01/Épisode 01 名前.mkv', content: 'Hello, World! '.repeat(1000) },
    { name: 'Show/Season 02/episode 2.mkv', content: 'Second file content.\n'.repeat(500) },
    { name: 'readme.txt', content: 'plain ascii' },
  ];
  const zipPath = await buildZip(t, files);
  const result = await inspectWithPython(zipPath);
  assert.equal(result.bad, null);
  assert.deepEqual(result.names, files.map(f => f.name));
  for (const file of files) {
    assert.equal(result.sizes[file.name], Buffer.byteLength(file.content));
    assert.equal(result.contents[file.name], file.content);
  }
});

test('many entries round-trip in order with distinct offsets', async t => {
  const files = Array.from({ length: 25 }, (_, i) => ({ name: `folder/file-${i}.bin`, content: `entry-${i}-`.repeat(50 + i) }));
  const zipPath = await buildZip(t, files);
  const result = await inspectWithPython(zipPath);
  assert.equal(result.bad, null);
  assert.deepEqual(result.names, files.map(f => f.name));
  for (const file of files) assert.equal(result.contents[file.name], file.content);
});

test('a file that reads shorter than its declared size throws instead of producing a silently truncated entry', async t => {
  const dir = await tmpDir(t, 'debridarr-zip-mismatch');
  const path = join(dir, 'short.bin');
  await writeFile(path, Buffer.alloc(10, 1));
  const out = new PassThrough();
  out.resume();
  const writer = new ZipWriter(out, new AbortController().signal);
  await assert.rejects(
    writer.addFile({ name: 'short.bin', size: 20, open: () => open(path, 'r') }),
    /changed size while zipping/,
  );
});

test('backpressure on a slow writable is respected — no data is dropped', async t => {
  const dir = await tmpDir(t, 'debridarr-zip-backpressure');
  const content = 'x'.repeat(500_000);
  const path = join(dir, 'big.bin');
  await writeFile(path, content);
  const chunks: Buffer[] = [];
  let paused = true;
  const out = new PassThrough({ highWaterMark: 1024 });
  out.on('data', chunk => chunks.push(chunk as Buffer));
  out.pause();
  setTimeout(() => { paused = false; out.resume(); }, 20);
  const writer = new ZipWriter(out, new AbortController().signal);
  await writer.addFile({ name: 'big.bin', size: content.length, open: () => open(path, 'r') });
  await writer.finish();
  assert.equal(paused, false, 'the writer awaited drain instead of racing ahead of a paused consumer');
  const zipPath = join(dir, 'out.zip');
  await writeFile(zipPath, Buffer.concat(chunks));
  const result = await inspectWithPython(zipPath);
  assert.equal(result.bad, null);
  assert.equal(result.contents['big.bin'], content);
});
