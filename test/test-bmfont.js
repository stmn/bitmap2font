// Test eksportu BMFont: metryki .fnt walidowane zewnetrznym parserem
// (parse-bmfont-ascii - uzywany w ekosystemie Phasera), atlas porownany
// piksel-po-pikselu ze zrodlem, zip weryfikowany systemowym unzip.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const opentype = require('opentype.js');
const { Font: FeFont } = require('fonteditor-core');
const { PNG } = require('pngjs');
const parseBmfont = require('parse-bmfont-ascii');
const core = require('../dist/core.js');
const colorfont = require('../dist/colorfont.js');
const bmfont = require('../dist/bmfont.js');

const deps = { encodePng: colorfont.encodePng, crc32: colorfont.crc32 };

// --- arkusz syntetyczny (jak w test-color): A z miekka obwodka, B, spacja, C
const CELL = 12, COLS = 2, ROWS = 2;
const W = CELL * COLS, H = CELL * ROWS;
const rgba = new Uint8ClampedArray(W * H * 4);
function px(x, y, r, g, b, a) {
  const i = (y * W + x) * 4;
  rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
}
for (let y = 3; y <= 8; y++) for (let x = 3; x <= 8; x++) {
  const edge = x === 3 || x === 8 || y === 3 || y === 8;
  px(x, y, 220, 40, 30, edge ? 128 : 255);
}
for (let y = 4; y <= 7; y++) for (let x = 2; x <= 9; x++) px(CELL + x, y, 40, 80, 220, 255);
px(CELL + 2, CELL + 2, 30, 200, 90, 255);

const grid = { offsetX: 0, offsetY: 0, cellW: CELL, cellH: CELL, spacingX: 0, spacingY: 0 };
const opts = { name: 'BmTest', baseline: 2, threshold: 128, mono: false, letterSpacing: 1, spaceWidth: 5, colorFont: false };

const res = core.buildFonts({ opentype, FeFont, colorfont }, rgba, W, H, grid, 'AB C', opts);
assert.ok(res.previewGlyphs, 'bitmapy glifow dostepne bez colorFont');

const bm = bmfont.build({
  name: 'BmTest', slug: 'bmtest',
  cellH: res.previewMetrics.cellH, base: res.previewMetrics.ascenderPx,
  glyphs: res.previewGlyphs,
}, deps);

// --- walidacja zewnetrznym parserem
const parsed = parseBmfont(bm.fnt);
assert.strictEqual(parsed.info.face, 'BmTest');
assert.strictEqual(parsed.common.lineHeight, 12, 'lineHeight = cellH');
assert.strictEqual(parsed.common.base, 10, 'base = ascender (cellH - baseline)');
assert.strictEqual(parsed.pages[0], 'bmtest_0.png');
assert.strictEqual(parsed.chars.length, 4, '4 znaki (A, B, spacja, C)');

const byId = new Map(parsed.chars.map((c) => [c.id, c]));
const A = byId.get(65);
assert.strictEqual(A.width, 6);
assert.strictEqual(A.height, 6);
assert.strictEqual(A.xoffset, 0, 'A: bearingX 0 (crop = kontur)');
assert.strictEqual(A.yoffset, 3, 'A: base(10) - topY(7)');
assert.strictEqual(A.xadvance, 7, 'A: 6 px + letterSpacing 1');
const SP = byId.get(32);
assert.strictEqual(SP.width, 0);
assert.strictEqual(SP.xadvance, 5, 'spacja = spaceWidth');
const B = byId.get(66);
assert.strictEqual(B.height, 4);
assert.strictEqual(B.xadvance, 9, 'B: 8 px + 1');

// pozycje w atlasie: brak nakladania i 1 px marginesu
const rects = parsed.chars.filter((c) => c.width > 0);
for (const a of rects) {
  assert.ok(a.x >= 1 && a.y >= 1, 'margines od krawedzi');
  assert.ok(a.x + a.width <= parsed.common.scaleW, 'miesci sie w atlasie');
  assert.ok(a.y + a.height <= parsed.common.scaleH);
  for (const b of rects) {
    if (a === b) continue;
    const overlap = a.x < b.x + b.width && b.x < a.x + a.width
      && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(!overlap, `glify ${a.id} i ${b.id} nachodza na siebie`);
  }
}

// --- atlas: piksele A identyczne ze zrodlem (crop 3..8 x 3..8)
const atlas = PNG.sync.read(Buffer.from(bm.png));
assert.strictEqual(atlas.width, parsed.common.scaleW);
assert.strictEqual(atlas.height, parsed.common.scaleH);
for (let y = 0; y < 6; y++) {
  for (let x = 0; x < 6; x++) {
    const src = ((3 + y) * W + (3 + x)) * 4;
    const dst = ((A.y + y) * atlas.width + (A.x + x)) * 4;
    for (let k = 0; k < 4; k++) {
      assert.strictEqual(atlas.data[dst + k], rgba[src + k],
        `atlas piksel (${x},${y}) kanal ${k}`);
    }
  }
}

// --- zip: systemowy unzip potwierdza strukture i zawartosc
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, 'bmtest-bmfont.zip');
fs.writeFileSync(zipPath, Buffer.from(bm.zip));
const listing = execSync(`unzip -l ${zipPath}`).toString();
assert.ok(listing.includes('bmtest.fnt'), 'zip zawiera .fnt');
assert.ok(listing.includes('bmtest_0.png'), 'zip zawiera atlas');
const fntFromZip = execSync(`unzip -p ${zipPath} bmtest.fnt`).toString();
assert.strictEqual(fntFromZip, bm.fnt, 'zawartosc .fnt w zipie identyczna');
const crcCheck = execSync(`unzip -t ${zipPath}`).toString();
assert.ok(crcCheck.includes('No errors detected'), 'unzip -t: sumy CRC poprawne');

// --- pelny ASCII z przykladowego arkusza
let chars = '';
for (let c = 32; c <= 126; c++) chars += String.fromCharCode(c);
const ex = PNG.sync.read(fs.readFileSync(path.join(__dirname, '../dist/example.png')));
const res2 = core.buildFonts({ opentype, FeFont, colorfont },
  new Uint8ClampedArray(ex.data), ex.width, ex.height,
  { offsetX: 0, offsetY: 0, cellW: 8, cellH: 8, spacingX: 0, spacingY: 0 },
  chars, { name: 'Example', baseline: 0, threshold: 128, mono: true, letterSpacing: 1, spaceWidth: 4, colorFont: false });
const bm2 = bmfont.build({
  name: 'Example', slug: 'example',
  cellH: 8, base: 8, glyphs: res2.previewGlyphs,
}, deps);
const parsed2 = parseBmfont(bm2.fnt);
assert.strictEqual(parsed2.chars.length, 95, 'pelny ASCII');
for (const c of parsed2.chars) {
  assert.strictEqual(c.xadvance, 8, `mono: advance 8 dla znaku ${c.id}`);
}
fs.writeFileSync(path.join(outDir, 'example-bmfont.zip'), Buffer.from(bm2.zip));

console.log('BMFONT OK - fnt zwalidowany parserem, atlas 1:1 ze zrodlem, zip CRC OK');
console.log('atlas syntetyczny:', `${parsed.common.scaleW}x${parsed.common.scaleH}`,
  '| przykladowy ASCII:', `${parsed2.common.scaleW}x${parsed2.common.scaleH}`);
