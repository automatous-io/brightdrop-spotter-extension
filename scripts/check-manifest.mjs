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

// Fails if the manifest is malformed or points at a file that is not in the repo.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'version must be x.y.z');
assert.equal(manifest.version, pkg.version, 'manifest.json and package.json versions differ');
assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} chars; the Web Store cap is 132`);

const files = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon),
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
];
for (const f of files) assert.ok(existsSync(resolve(root, f)), `manifest references missing file: ${f}`);

// The worker's static imports must resolve too; a missing module only fails at load time in Chrome.
const worker = readFileSync(resolve(root, manifest.background.service_worker), 'utf8');
for (const [, spec] of worker.matchAll(/^import .* from '(\.\/[^']+)';/gm)) {
  assert.ok(existsSync(resolve(root, spec)), `background.js imports missing module: ${spec}`);
}

console.log(`manifest ok: ${manifest.name} ${manifest.version}, ${files.length} referenced files present`);
