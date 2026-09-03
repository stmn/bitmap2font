// Test color fontu: syntetyczny arkusz z antyaliasingiem i kolorami ->
// buildFonts(colorFont) -> walidacja tablic CBDT/CBLC/sbix.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const { Font: FeFont } = require('fonteditor-core');
const core = require('../dist/core.js');
const colorfont = require('../dist/colorfont.js');

const CELL = 12, COLS = 2, ROWS = 2;
const W = CELL * COLS, H = CELL * ROWS;
const rgba = new Uint8ClampedArray(W * H * 4); // przezroczyste tlo

function px(x, y, r, g, b, a) {
  const i = (y * W + x) * 4;
  rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
}

// 'A' (0,0): czerwony kwadrat 4x4 w srodku + miekka obwodka alpha=128 (AA)
for (let y = 3; y <= 8; y++) for (let x = 3; x <= 8; x++) {
  const edge = x === 3 || x === 8 || y === 3 || y === 8;
  px(x, y, 220, 40, 30, edge ? 128 : 255);
}
// 'B' (1,0): niebieski pasek pelny
for (let y = 4; y <= 7; y++) for (let x = 2; x <= 9; x++) px(CELL + x, y, 40, 80, 220, 255);
// (0,1): spacja - pusta; 'C' (1,1): zielony piksel w rogu
px(CELL + 2, CELL + 2, 30, 200, 90, 255);

const grid = { offsetX: 0, offsetY: 0, cellW: CELL, cellH: CELL, spacingX: 0, spacingY: 0 };
const opts = {
  name: 'ColorTest', baseline: 2, threshold: 128, mono: false,
  letterSpacing: 1, spaceWidth: 5, colorFont: true,
};

const res = core.buildFonts({ opentype, FeFont, colorfont }, rgba, W, H, grid, 'AB C', opts);
assert.ok(res.colorized, 'font oznaczony jako kolorowy');

// TTF nadal parsowalny, konturowy fallback na miejscu
const parsed = opentype.parse(res.ttf);
assert.ok(parsed.charToGlyphIndex('A') > 0, 'cmap dziala po wstrzyknieciu tablic');

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'color.ttf'), Buffer.from(res.ttf));

// PNG z naszego enkodera musi byc dekodowalny (sprawdzi to czesc pythonowa)
const png = colorfont.encodePng(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
assert.deepStrictEqual([...png.slice(0, 4)], [137, 80, 78, 71], 'sygnatura PNG');

console.log('NODE OK - color.ttf zapisany, glyphCount', res.glyphCount);

// --- Wlasny .notdef w color foncie: bitmapa i warstwy COLR pod gid 0 ----
function findTable(buf, tag) {
  const v = new DataView(buf);
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    if (String.fromCharCode(...new Uint8Array(buf, o, 4)) === tag) {
      return { offset: v.getUint32(o + 8), length: v.getUint32(o + 12) };
    }
  }
  return null;
}
{
  const r = core.buildFonts({ opentype, FeFont, colorfont }, rgba, W, H, grid, 'AB C',
    { ...opts, colr: true, notdefChar: 'A' });
  assert.strictEqual(r.notdefFrom, 'A'.codePointAt(0), 'color: notdefFrom = A');
  const p = opentype.parse(r.ttf);
  assert.strictEqual(p.glyphs.get(0).advanceWidth, p.charToGlyph('A').advanceWidth, 'color: advance .notdef = A');

  // CBLC: indexSubtable format 1 od bajtu 64, offsety od 72 - gid 0 ma dane
  const cblc = findTable(r.ttf, 'CBLC');
  assert.ok(cblc, 'color: tablica CBLC');
  const cv = new DataView(r.ttf, cblc.offset, cblc.length);
  const off0 = cv.getUint32(72), off1 = cv.getUint32(76);
  assert.ok(off1 > off0, 'color: gid 0 ma bitmape w CBDT');

  // COLR: posortowane base records, pierwszy to gid 0 z warstwami jak A
  const colr = findTable(r.ttf, 'COLR');
  assert.ok(colr, 'color: tablica COLR');
  const xv = new DataView(r.ttf, colr.offset, colr.length);
  const nB = xv.getUint16(2);
  const recs = [];
  for (let i = 0; i < nB; i++) recs.push({ gid: xv.getUint16(14 + i * 6), first: xv.getUint16(16 + i * 6), num: xv.getUint16(18 + i * 6) });
  const recA = recs.find((x) => x.gid === p.charToGlyphIndex('A'));
  assert.ok(recA && recA.num > 0, 'color: A ma warstwy COLR');
  assert.deepStrictEqual(recs[0], { gid: 0, first: recA.first, num: recA.num }, 'color: gid 0 dzieli warstwy z A');
  console.log('OK - .notdef w color foncie');
}
