// Test pipeline'u bez przeglądarki: syntetyczna bitmapa -> buildFonts -> parsowanie wyników.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const { Font: FeFont } = require('fonteditor-core');
const core = require('../dist/core.js');

// Siatka 2x2, komórki 8x8, znaki "AB C" -> użyte 4: A, B, spacja... ("AB C" ma 4 znaki: A,B,' ',C)
const CELL = 8, COLS = 2, ROWS = 2;
const W = CELL * COLS, H = CELL * ROWS;

// rysowanie: czarne piksele na białym tle
const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
function px(x, y) {
  const i = (y * W + x) * 4;
  rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
}
function cellPx(c, r, x, y) { px(c * CELL + x, r * CELL + y); }

// A (0,0): pełny kwadrat 6x6 z marginesem 1
for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) cellPx(0, 0, x, y);
// B (1,0): ramka 6x6 (kwadrat z dziurą 4x4) - test konturu wewnętrznego
for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) {
  if (x === 1 || x === 6 || y === 1 || y === 6) cellPx(1, 0, x, y);
}
// komórka (0,1): spacja - pusta
// C (1,1): dwie osobne kolumny - test wielu konturów
for (let y = 1; y <= 6; y++) { cellPx(1, 1, 1, y); cellPx(1, 1, 5, y); }

const grid = { offsetX: 0, offsetY: 0, cellW: CELL, cellH: CELL, spacingX: 0, spacingY: 0 };
const opts = { name: 'TestFont', baseline: 1, threshold: 128, mono: false, letterSpacing: 1, spaceWidth: 4 };

const res = core.buildFonts({ opentype, FeFont }, rgba, W, H, grid, 'AB C', opts);
assert.strictEqual(res.glyphCount, 4, 'liczba glifów');
assert.strictEqual(res.emptyCells, 1, 'pusta komórka (spacja)');
assert.ok(!res.truncated, 'bez obcięcia');

const scale = 1000 / CELL;

for (const [label, buf] of [['OTF', res.otf], ['TTF', res.ttf]]) {
  const f = opentype.parse(buf);
  const gA = f.charToGlyph('A');
  const gB = f.charToGlyph('B');
  const gSp = f.charToGlyph(' ');
  const gC = f.charToGlyph('C');

  // proporcjonalnie: A ma 6 px szerokości + 1 letterSpacing = 7 px
  assert.strictEqual(gA.advanceWidth, 7 * scale, label + ': advance A');
  assert.strictEqual(gSp.advanceWidth, 4 * scale, label + ': advance spacji');
  assert.strictEqual(gC.advanceWidth, 6 * scale, label + ': advance C (5-1+1 px + 1 spacing)');

  // bounding box A: x 0..6*125 (origin przesunięty o minX), y: baseline=1 -> dolna krawędź
  // pikselowego kwadratu (py=6) ma y_font = (8-7-1)*125 = 0... góra (py=1): (8-1-1)*125 = 750
  const bbA = gA.getBoundingBox();
  assert.strictEqual(bbA.x1, 0, label + ': A x1');
  assert.strictEqual(bbA.x2, 6 * scale, label + ': A x2');
  assert.strictEqual(bbA.y1, 0, label + ': A y1');
  assert.strictEqual(bbA.y2, 6 * scale, label + ': A y2');

  // B ma dziurę: renderowanie w punkcie środka nie powinno być wypełnione.
  // Sprawdzamy przez liczbę konturów ścieżki (2 zamknięte pętle => 2x 'Z').
  const closesB = gB.path.commands.filter((c) => c.type === 'Z').length;
  assert.strictEqual(closesB, 2, label + ': B ma 2 kontury (zewn. + dziura)');
  const closesC = gC.path.commands.filter((c) => c.type === 'Z').length;
  assert.strictEqual(closesC, 2, label + ': C ma 2 osobne kontury');
  console.log(label, 'OK -', f.numGlyphs, 'glifów,', 'A adv', gA.advanceWidth);
}

// Tryb mono: każdy advance = cellW
const resMono = core.buildFonts({ opentype, FeFont }, rgba, W, H, grid, 'AB C', { ...opts, mono: true });
const fMono = opentype.parse(resMono.otf);
for (const ch of ['A', 'B', ' ', 'C']) {
  assert.strictEqual(fMono.charToGlyph(ch).advanceWidth, CELL * scale, 'mono advance ' + ch);
}
console.log('MONO OK');

// zapis artefaktów do ręcznej weryfikacji (Font Book)
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'test.otf'), Buffer.from(res.otf));
fs.writeFileSync(path.join(outDir, 'test.ttf'), Buffer.from(res.ttf));
console.log('Zapisano test/out/test.otf i test.ttf');

// --- Wlasny .notdef: klon glifu wskazanego znaku pod gid 0 -------------
{
  const r = core.buildFonts({ opentype, FeFont }, rgba, W, H, grid, 'AB C', { ...opts, notdefChar: 'B' });
  assert.strictEqual(r.notdefFrom, 'B'.codePointAt(0), 'notdefFrom = kod B');
  assert.strictEqual(r.glyphCount, 4, 'notdef nie zmienia liczby glifow');
  for (const [label, buf] of [['OTF', r.otf], ['TTF', r.ttf]]) {
    const f = opentype.parse(buf);
    const g0 = f.glyphs.get(0);
    const gB = f.charToGlyph('B');
    if (label === 'OTF') assert.strictEqual(g0.name, '.notdef', 'gid 0 to .notdef'); // TTF z fonteditora nie niesie nazw
    assert.strictEqual(g0.advanceWidth, gB.advanceWidth, label + ': advance .notdef = B');
    assert.deepStrictEqual(g0.getBoundingBox(), gB.getBoundingBox(), label + ': bbox .notdef = B');
    assert.strictEqual(g0.path.commands.length, gB.path.commands.length, label + ': kontur .notdef = B');
    assert.strictEqual(f.charToGlyphIndex('Z'), 0, label + ': znak spoza fontu -> gid 0');
  }
  // znak spoza listy: bez bledu, .notdef zostaje pusty
  const r2 = core.buildFonts({ opentype, FeFont }, rgba, W, H, grid, 'AB C', { ...opts, notdefChar: 'Z' });
  assert.strictEqual(r2.notdefFrom, null, 'notdefFrom null gdy znaku nie ma na liscie');
  assert.strictEqual(opentype.parse(r2.ttf).glyphs.get(0).path.commands.length, 0, 'pusty .notdef bez zrodla');
  console.log('OK - .notdef z komorki B');
}
