import { watch } from 'node:fs';
import { spawn } from 'node:child_process';

let server;
let rebuilding = false;
let pending = false;
let stopping = false;
let timer;
let build;

function start() {
  server = spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/index.js'], { stdio: 'inherit' });
}
async function rebuild() {
  if (stopping) return;
  if (rebuilding) { pending = true; return; }
  rebuilding = true;
  build = spawn('npm', ['run', 'build'], { stdio: 'inherit' });
  const code = await new Promise(resolve => { build.once('exit', resolve); build.once('error', () => resolve(1)); });
  if (code === 0 && !stopping) {
    if (server && server.exitCode === null && server.signalCode === null) {
      await new Promise(resolve => { server.once('exit', resolve); server.kill('SIGTERM'); });
    }
    if (!stopping) start();
  }
  rebuilding = false;
  if (pending) { pending = false; void rebuild(); }
}
const watchers = ['src', 'web'].map(directory => watch(directory, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 150);
}));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  clearTimeout(timer);
  watchers.forEach(watcher => watcher.close());
  server?.kill('SIGTERM');
  build?.kill('SIGTERM');
});
start();
