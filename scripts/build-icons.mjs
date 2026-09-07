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

// Renders the extension icons. Needs sharp: `npm i -D sharp` once, then `npm run icons`.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../icons/', import.meta.url));

// Material Design Icons "van-utility" (Pictogrammers, Apache-2.0).
const VAN = 'M3,7C1.89,7 1,7.89 1,9V17H3A3,3 0 0,0 6,20A3,3 0 0,0 9,17H15A3,3 0 0,0 18,20A3,3 0 0,0 21,17H23V13C23,11.89 22.11,11 21,11L18,7H3M15,8.5H17.5L19.46,11H15V8.5M6,15.5A1.5,1.5 0 0,1 7.5,17A1.5,1.5 0 0,1 6,18.5A1.5,1.5 0 0,1 4.5,17A1.5,1.5 0 0,1 6,15.5M18,15.5A1.5,1.5 0 0,1 19.5,17A1.5,1.5 0 0,1 18,18.5A1.5,1.5 0 0,1 16.5,17A1.5,1.5 0 0,1 18,15.5Z';

// Van inset inside the tile. Tighter at small sizes so the glyph stays legible.
const svg = (size, pad) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#0F6FD1"/>
  <g transform="translate(${pad},${pad}) scale(${(size - pad * 2) / 24})">
    <path d="${VAN}" fill="#FFFFFF"/>
  </g>
</svg>`;

for (const [size, pad] of [[16, 1.5], [32, 3], [48, 5], [128, 13]]) {
  await sharp(Buffer.from(svg(size, pad))).png().toFile(`${outDir}${size}.png`);
}
console.log('icons rendered');
