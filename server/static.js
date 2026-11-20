/**
 * Tiny static file server for the TV + phone pages.
 * No framework, no build step: the browser loads the ES modules directly.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};

const ONE_YEAR = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache, must-revalidate';

export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  /** @returns {Promise<boolean>} true when the request was handled */
  return async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel.includes('\0')) return false;

    // Pretty routes: /tv, /m, /m/CODE
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel === '/tv') rel = '/tv.html';
    if (rel === '/m' || rel === '/mobile') rel = '/mobile.html';
    if (rel.startsWith('/m/')) {
      // Handled by the page itself (reads the code from the path), still serve mobile.html.
      res.writeHead(302, { Location: `/mobile.html?c=${encodeURIComponent(rel.slice(3))}` });
      res.end();
      return true;
    }

    const filePath = path.join(root, rel);
    // Directory-traversal guard.
    if (!filePath.startsWith(root + path.sep) && filePath !== root) return false;

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return false;
    }
    if (stat.isDirectory()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const isVendor = filePath.includes(`${path.sep}vendor${path.sep}`);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': isVendor ? ONE_YEAR : NO_CACHE,
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    };

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : stat.size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
          end = Math.min(end, stat.size - 1);
          res.writeHead(206, {
            ...headers,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          });
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return true;
        }
      }
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(filePath).pipe(res);
    return true;
  };
}
