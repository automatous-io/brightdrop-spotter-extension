//
// Copyright 2026 AUTOMATOUS.IO
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

// The website is web/ plus the decoder it shares with the extension.
//   node scripts/web.mjs serve [port]   preview at http://localhost:8080
//   node scripts/web.mjs build <dir>    assemble the site for GitHub Pages
import { createServer } from 'node:http';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = resolve(root, 'web');

/** Files that live outside web/ and are served beside it, so there is one copy of the decoder. */
const SHARED = {
  'vin.js': 'vin.js',
  'sticker.js': 'sticker.js',
  'hero.png': 'docs/screenshots/hero.png',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

function build(outDir) {
  if (!outDir) throw new Error('usage: node scripts/web.mjs build <dir>');
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  cpSync(webDir, out, { recursive: true });
  for (const [name, from] of Object.entries(SHARED)) copyFileSync(resolve(root, from), resolve(out, name));
  console.log(`site built in ${out}`);
}

function serve(port = 8080) {
  createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = SHARED[path] ? resolve(root, SHARED[path]) : resolve(webDir, path);
    const inside = SHARED[path] || file.startsWith(webDir + sep);
    if (!inside || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'build') build(arg);
else if (cmd === 'serve') serve(arg ? Number(arg) : undefined);
else { console.error('usage: node scripts/web.mjs serve [port] | build <dir>'); process.exit(1); }
