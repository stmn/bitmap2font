// Testy importerow: BDF (fixture + prawdziwy font), BMFont (roundtrip
// z naszym eksporterem, piksel-po-pikselu), Windows FNT/FON (fixture binarna),
// pelny pipeline import -> TTF walidowany przez opentype.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const { Font: FeFont } = require('fonteditor-core');
const { PNG } = require('pngjs');
const core = require('../dist/core.js');
const colorfont = require('../dist/colorfont.js');
const bmfont = require('../dist/bmfont.js');
const imp = require('../dist/importers.js');

// --- BDF: fixture z dokladnie znanymi glifami --------------------------
const BDF = `STARTFONT 2.1
FONT -test
SIZE 8 75 75
FONTBOUNDINGBOX 8 8 0 -2
STARTPROPERTIES 2
FONT_ASCENT 6
FONT_DESCENT 2
ENDPROPERTIES
CHARS 2
STARTCHAR A
ENCODING 65
DWIDTH 5 0
BBX 4 4 0 0
BITMAP
90
F0
90
90
ENDCHAR
STARTCHAR g
ENCODING 103
DWIDTH 5 0
BBX 4 5 1 -2
BITMAP
70
90
70
10
60
ENDCHAR
ENDFONT
`;
const bdf = imp.parseBdf(BDF);
assert.strictEqual(bdf.ascent, 6);
assert.strictEqual(bdf.descent, 2);
assert.strictEqual(bdf.glyphs.length, 2);
const A = bdf.glyphs.find((g) => g.code === 65);
assert.deepStrictEqual([A.w, A.h, A.bearingX, A.topY, A.advance], [4, 4, 0, 4, 5]);
// wiersz "90" = 1001 -> piksele (0,0) i (3,0)
assert.strictEqual(A.rgba[3], 255);
assert.strictEqual(A.rgba[(0 * 4 + 1) * 4 + 3], 0);
assert.strictEqual(A.rgba[(0 * 4 + 3) * 4 + 3], 255);
const G = bdf.glyphs.find((g) => g.code === 103);
assert.deepStrictEqual([G.bearingX, G.topY], [1, 3]); // oy=-2, h=5 -> topY 3 (2 px pod baseline)

// sniff
assert.strictEqual(imp.sniff(new TextEncoder().encode(BDF), 'x.bdf'), 'bdf');

// --- pelny pipeline: BDF -> sheet -> TTF -------------------------------
const sheet = imp.buildSheet(bdf);
assert.strictEqual(sheet.baseline, 2);
assert.strictEqual(sheet.cellH, 8);
const res = core.buildFonts({ opentype, FeFont, colorfont },
  sheet.rgba, sheet.w, sheet.h,
  { offsetX: 0, offsetY: 0, cellW: sheet.cellW, cellH: sheet.cellH, spacingX: 0, spacingY: 0 },
  sheet.chars,
  { name: sheet.name, baseline: sheet.baseline, threshold: 128, mono: false,
    letterSpacing: 1, spaceWidth: 4, colorFont: false, overrides: sheet.overrides });
const f = opentype.parse(res.ttf);
const scale = 1000 / sheet.cellH;
assert.strictEqual(f.charToGlyph('A').advanceWidth, Math.round(5 * scale), 'advance z DWIDTH, nie z trimu');
assert.strictEqual(f.charToGlyph('g').advanceWidth, Math.round(5 * scale));
const bbA = f.charToGlyph('A').getBoundingBox();
assert.strictEqual(bbA.y1, 0, 'A siedzi na baseline');
const bbG = f.charToGlyph('g').getBoundingBox();
assert.strictEqual(bbG.y1, Math.round(-2 * scale), 'descender g schodzi 2 px pod baseline');
assert.strictEqual(bbG.x1, Math.round(1 * scale), 'bearing g z BBX');

// --- BMFont roundtrip: nasz eksport -> import -> te same piksele -------
const ex = PNG.sync.read(fs.readFileSync(path.join(__dirname, '../dist/example.png')));
let chars = '';
for (let c = 32; c <= 126; c++) chars += String.fromCharCode(c);
const res2 = core.buildFonts({ opentype, FeFont, colorfont },
  new Uint8ClampedArray(ex.data), ex.width, ex.height,
  { offsetX: 0, offsetY: 0, cellW: 8, cellH: 8, spacingX: 0, spacingY: 0 },
  chars, { name: 'Ex', baseline: 0, threshold: 128, mono: false, letterSpacing: 1, spaceWidth: 4, colorFont: false });
const bm = bmfont.build({ name: 'Ex', slug: 'ex', cellH: 8, base: 8, glyphs: res2.previewGlyphs },
  { encodePng: colorfont.encodePng, crc32: colorfont.crc32 });
const meta = imp.parseBmfontText(bm.fnt);
assert.strictEqual(meta.pageFile, 'ex_0.png');
const atlasPng = PNG.sync.read(Buffer.from(bm.png));
const imported = imp.attachAtlas(meta, { rgba: new Uint8ClampedArray(atlasPng.data), w: atlasPng.width, h: atlasPng.height });
for (const g of imported.glyphs) {
  const orig = res2.previewGlyphs.get(g.code);
  assert.ok(orig, `brak oryginalu ${g.code}`);
  assert.strictEqual(g.advance, Math.round(orig.advancePx), `advance ${g.code}`);
  if (!orig.data) { assert.strictEqual(g.w, 0, `pusty glif ${g.code}`); continue; }
  assert.strictEqual(g.w, orig.w, `szerokosc ${g.code}`);
  assert.strictEqual(g.topY, orig.topY, `topY ${g.code}`);
  assert.deepStrictEqual([...g.rgba], [...orig.data], `piksele ${g.code}`);
}
assert.strictEqual(imp.sniff(new TextEncoder().encode(bm.fnt), 'ex.fnt'), 'bmfont-text');

// --- Windows FNT: fixture binarna v2 -----------------------------------
function makeFnt() {
  // 2 znaki: 'A' (0x41) szer. 3: kolumny 100/110/100 pion? ustawmy prosty wzor
  const first = 0x41, last = 0x42, pixHeight = 4, asc = 3;
  const tableOff = 118, entries = last - first + 2;
  const bitsOff = tableOff + entries * 4;
  const buf = new Uint8Array(bitsOff + 2 * pixHeight); // 2 glify po 1 bajto-kolumnie
  const v = new DataView(buf.buffer);
  v.setUint16(0, 0x0200, true);
  v.setUint16(66, 0, true);       // raster
  v.setUint16(74, asc, true);     // ascent
  v.setUint16(88, pixHeight, true);
  buf[95] = first; buf[96] = last;
  // char table: width + offset
  v.setUint16(tableOff, 3, true); v.setUint16(tableOff + 2, bitsOff, true);
  v.setUint16(tableOff + 4, 2, true); v.setUint16(tableOff + 6, bitsOff + pixHeight, true);
  // 'A' 3 px: wiersze: 010 101 111 101 -> bity MSB: 0b010.., 0b101..
  buf[bitsOff + 0] = 0b01000000;
  buf[bitsOff + 1] = 0b10100000;
  buf[bitsOff + 2] = 0b11100000;
  buf[bitsOff + 3] = 0b10100000;
  // 'B' 2 px: pelny kwadrat
  buf[bitsOff + 4] = 0b11000000;
  buf[bitsOff + 5] = 0b11000000;
  buf[bitsOff + 6] = 0b11000000;
  buf[bitsOff + 7] = 0b11000000;
  return buf;
}
const fnt = imp.parseWinFnt(makeFnt());
assert.strictEqual(fnt.ascent, 3);
assert.strictEqual(fnt.descent, 1);
const FA = fnt.glyphs.find((g) => g.code === 0x41);
assert.deepStrictEqual([FA.w, FA.h, FA.advance], [3, 4, 3]);
assert.strictEqual(FA.rgba[(0 * 3 + 1) * 4 + 3], 255, 'A(1,0) on');
assert.strictEqual(FA.rgba[(0 * 3 + 0) * 4 + 3], 0, 'A(0,0) off');
assert.strictEqual(imp.sniff(makeFnt(), 'test.fnt'), 'winfnt');

// --- FON: fixture NE z zasobem RT_FONT ---------------------------------
function makeFon(fntBytes) {
  const shift = 4;
  const align = 1 << shift;
  const neOff = 64;
  const resOff = neOff + 40;
  // res table: shift(2) + typeinfo(8) + nameinfo(12) + end(2)
  const resLen = 2 + 8 + 12 + 2;
  let fontOff = resOff + resLen;
  fontOff = Math.ceil(fontOff / align) * align;
  const total = fontOff + fntBytes.length;
  const buf = new Uint8Array(total);
  const v = new DataView(buf.buffer);
  buf[0] = 0x4d; buf[1] = 0x5a;
  v.setUint32(60, neOff, true);
  buf[neOff] = 0x4e; buf[neOff + 1] = 0x45;
  v.setUint16(neOff + 36, resOff - neOff, true);
  v.setUint16(resOff, shift, true);
  v.setUint16(resOff + 2, 0x8008, true); // RT_FONT
  v.setUint16(resOff + 4, 1, true);      // count
  const ni = resOff + 10;
  v.setUint16(ni, fontOff >> shift, true);
  v.setUint16(ni + 2, Math.ceil(fntBytes.length / align), true);
  v.setUint16(resOff + resLen - 2, 0, true); // koniec typow
  buf.set(fntBytes, fontOff);
  return buf;
}
const fon = imp.parseFon(makeFon(makeFnt()));
assert.strictEqual(fon.glyphs.length, 2);
assert.strictEqual(imp.sniff(makeFon(makeFnt()), 'test.fon'), 'fon');

// --- BMFont binarny: zbuduj minimalny plik i sparsuj -------------------
function makeBmfBin() {
  const name = 'BinFace';
  const info = new Uint8Array(14 + name.length + 1);
  info.set(new TextEncoder().encode(name), 14);
  const common = new Uint8Array(15);
  const cv = new DataView(common.buffer);
  cv.setUint16(0, 10, true); // lineHeight
  cv.setUint16(2, 8, true);  // base
  const pages = new TextEncoder().encode('atlas_0.png\0');
  const chars = new Uint8Array(20);
  const chv = new DataView(chars.buffer);
  chv.setUint32(0, 65, true);
  chv.setUint16(4, 1, true); chv.setUint16(6, 2, true);
  chv.setUint16(8, 3, true); chv.setUint16(10, 4, true);
  chv.setInt16(12, 0, true); chv.setInt16(14, 1, true);
  chv.setInt16(16, 5, true);
  const blocks = [[1, info], [2, common], [3, pages], [4, chars]];
  let total = 4;
  for (const [, b] of blocks) total += 5 + b.length;
  const out = new Uint8Array(total);
  out.set([0x42, 0x4d, 0x46, 3]);
  let p = 4;
  for (const [t, b] of blocks) {
    out[p] = t;
    new DataView(out.buffer).setUint32(p + 1, b.length, true);
    out.set(b, p + 5);
    p += 5 + b.length;
  }
  return out;
}
const bin = imp.parseBmfontBinary(makeBmfBin());
assert.strictEqual(bin.name, 'BinFace');
assert.strictEqual(bin.base, 8);
assert.strictEqual(bin.chars[0].code, 65);
assert.strictEqual(bin.chars[0].advance, 5);
assert.strictEqual(imp.sniff(makeBmfBin(), 'x.fnt'), 'bmfont-bin');

console.log('IMPORT OK - BDF, BMFont text/bin (roundtrip 1:1), WinFNT, FON');
