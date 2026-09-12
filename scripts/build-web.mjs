import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist/web', { recursive: true });
await Promise.all(['index.html', 'style.css', 'downloading.mp4'].map(file => copyFile(`web/${file}`, `dist/web/${file}`)));
