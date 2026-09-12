import { createServer } from 'node:http';
import type { TestContext } from 'node:test';
import { parseInfoHash } from '../src/downloads/torrentFile.js';
import { listen } from './helpers.js';

export const SAMPLE_HASH = 'a'.repeat(40);
export const SAMPLE_TORRENT = Buffer.from('d4:infod6:lengthi100e4:name9:movie.mkv12:piece lengthi16384e6:pieces20:XXXXXXXXXXXXXXXXXXXXee');

export interface FakeQbtFile { index: number; name: string; size: number; progress: number; priority: number }

export const defaultFileList = (): FakeQbtFile[] => [
  { index: 0, name: 'movie.mkv', size: 100, progress: 1, priority: 1 },
  { index: 1, name: 'unselected.mkv', size: 50, progress: 0, priority: 0 },
  { index: 2, name: 'readme.nfo', size: 5, progress: 1, priority: 1 },
];

export interface FakeQbtTorrent { hash: string; tags: string; paused: boolean }

export interface FakeQbt {
  url: string;
  torrents: Map<string, FakeQbtTorrent>;
  fileList: FakeQbtFile[];
  state: { freeBytes: number; progress: number };
  failures: Set<string>;
  onAdd: ((hash: string) => void) | undefined;
  setFilesReady: (ready: boolean) => void;
  categoryReads: () => number;
}

export async function listenFakeQbit(t: TestContext, options: { savePath: string; contentPath?: string; files?: FakeQbtFile[] }): Promise<FakeQbt> {
  const torrents = new Map<string, FakeQbtTorrent>();
  const fileList = options.files ?? defaultFileList();
  const state = { freeBytes: 100e9, progress: 1 };
  const failures = new Set<string>();
  let filesReady = true;
  let categoryReads = 0;
  const contentPath = options.contentPath ?? `${options.savePath}/movie.mkv`;
  const qbt: FakeQbt = {
    url: '', torrents, fileList, state, failures, onAdd: undefined,
    setFilesReady: ready => { filesReady = ready; },
    categoryReads: () => categoryReads,
  };
  qbt.url = await listen(createServer((request, response) => {
    void (async () => {
      const parsed = new URL(request.url!, 'http://x');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const form = new URLSearchParams(raw);
      if (failures.has(parsed.pathname.split('/').at(-1)!)) { response.statusCode = 503; response.end('offline'); return; }
      if (parsed.pathname.endsWith('/auth/login')) { response.setHeader('Set-Cookie', 'SID=s; Path=/'); response.end('Ok.'); return; }
      if (parsed.pathname.endsWith('/sync/maindata')) { response.end(JSON.stringify({ server_state: { free_space_on_disk: state.freeBytes } })); return; }
      if (parsed.pathname.endsWith('/torrents/filePrio')) {
        for (const file of fileList) if ((form.get('id') ?? '').split('|').includes(String(file.index))) file.priority = Number(form.get('priority'));
        response.end('Ok.'); return;
      }
      if (parsed.pathname.endsWith('/app/version')) { response.end('v5.0.0'); return; }
      if (parsed.pathname.endsWith('/torrents/add')) {
        let hash: string;
        let tags: string;
        let paused: boolean;
        if (request.headers['content-type']?.startsWith('multipart/form-data')) {
          hash = parseInfoHash(SAMPLE_TORRENT)!;
          tags = /name="tags"\r\n\r\n([^\r]+)/.exec(raw)?.[1] ?? '';
          paused = /name="(?:paused|stopped)"\r\n\r\ntrue/.test(raw);
        } else {
          hash = new URL(form.get('urls')!).searchParams.get('xt')!.slice(-40);
          tags = form.get('tags')!;
          paused = form.get('paused') === 'true' || form.get('stopped') === 'true';
        }
        torrents.set(hash, { hash, tags, paused });
        qbt.onAdd?.(hash);
        response.end('Ok.'); return;
      }
      if (parsed.pathname.endsWith('/torrents/pause') || parsed.pathname.endsWith('/torrents/stop')) {
        const row = torrents.get(form.get('hashes') ?? '');
        if (row) row.paused = true;
        response.end('Ok.'); return;
      }
      if (parsed.pathname.endsWith('/torrents/resume') || parsed.pathname.endsWith('/torrents/start')) {
        const row = torrents.get(form.get('hashes') ?? '');
        if (row) row.paused = false;
        response.end('Ok.'); return;
      }
      if (parsed.pathname.endsWith('/torrents/delete')) { torrents.delete(form.get('hashes')!); response.end('Ok.'); return; }
      response.setHeader('Content-Type', 'application/json');
      if (parsed.pathname.endsWith('/torrents/info')) {
        if (parsed.searchParams.has('category')) categoryReads++;
        response.end(JSON.stringify([...torrents.values()].filter(row => !parsed.searchParams.has('hashes') || row.hash === parsed.searchParams.get('hashes')).map(row => ({
          ...row, name: 'Movie', category: 'debridarr',
          state: row.paused ? (state.progress >= 1 ? 'pausedUP' : 'pausedDL') : (state.progress >= 1 ? 'uploading' : 'downloading'),
          progress: state.progress, size: 100, ratio: 0,
          save_path: options.savePath, content_path: contentPath, amount_left: 0, num_seeds: 1, num_leechs: 0, dlspeed: 0, eta: 0, seq_dl: true, f_l_piece_prio: true,
        })))); return;
      }
      if (parsed.pathname.endsWith('/torrents/files')) { response.end(filesReady ? JSON.stringify(fileList) : '[]'); return; }
      response.end('{}');
    })().catch(() => { response.statusCode = 500; response.end('{}'); });
  }), t);
  return qbt;
}
