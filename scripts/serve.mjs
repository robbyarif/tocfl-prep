// Minimal static server for public/. No dependencies.
// Usage: npm run dev  (then open http://localhost:8080)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const data = await fs.readFile(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    // Range support lets the browser seek inside audio (without it the MP3 is not seekable).
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && data.length) {
      let start = range[1] === '' ? Math.max(0, data.length - Number(range[2])) : Number(range[1]);
      let end = range[2] === '' || range[1] === '' ? data.length - 1 : Math.min(Number(range[2]), data.length - 1);
      if (start > end || start >= data.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`TOCFL prep running at http://localhost:${PORT}`));
