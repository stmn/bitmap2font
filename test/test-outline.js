// Tryb emoji-style (outlineFallback=false): puste kontury kolorowych glifow,
// ramka w .notdef (sanitizery odrzucaja zerowa tablice glyf), offsety sbix
// origin-relative. Tryb domyslny bez zmian.
const assert = require('assert');
const fs = require('fs');
const opentype = require('opentype.js');
const { Font: FeFont } = require('fonteditor-core');
const { PNG } = require('pngjs');
const core = require('../dist/core.js');
const colorfont = require('../dist/colorfont.js');

const png = PNG.sync.read(fs.readFileSync('test/out/rainbow-sheet.png'));
let chars = '';
for (let c = 32; c <= 126; c++) chars += String.fromCharCode(c);
const grid = { offsetX: 0, offsetY: 0, cellW: 14, cellH: 20, spacingX: 0, spacingY: 0 };
const base = { name: 'T', baseline: 4, threshold: 128, mono: false, letterSpacing: 1, spaceWidth: 4, colorFont: true };

const off = core.buildFonts({ opentype, FeFont, colorfont }, new Uint8ClampedArray(png.data),
  png.width, png.height, grid, chars, { ...base, outlineFallback: false });
const f1 = opentype.parse(off.ttf);
assert.strictEqual(f1.charToGlyph('A').path.commands.length, 0, 'emoji-style: A bez konturow');
assert.ok(f1.glyphs.get(0).path.commands.length > 0, 'emoji-style: notdef ma ramke');
assert.ok(off.colorized, 'emoji-style: tablice kolorow obecne');

const on = core.buildFonts({ opentype, FeFont, colorfont }, new Uint8ClampedArray(png.data),
  png.width, png.height, grid, chars, { ...base, outlineFallback: true });
const f2 = opentype.parse(on.ttf);
assert.ok(f2.charToGlyph('A').path.commands.length > 0, 'fallback on: A ma kontury');
assert.strictEqual(f2.glyphs.get(0).path.commands.length, 0, 'fallback on: notdef pusty jak dotad');

// bake scale: buduje sie i pilnuje limitu 120 px
const baked = core.buildFonts({ opentype, FeFont, colorfont }, new Uint8ClampedArray(png.data),
  png.width, png.height, grid, chars, { ...base, outlineFallback: false, bakeScale: 4 });
assert.ok(baked.colorized, 'bake 4x: tablice kolorow obecne');
assert.throws(
  () => core.buildFonts({ opentype, FeFont, colorfont }, new Uint8ClampedArray(png.data),
    png.width, png.height, grid, chars, { ...base, bakeScale: 8 }),
  /bake scale/i,
  'bake 8x przy komorce 20 px przekracza limit i rzuca czytelny blad',
);

// COLR: wektorowe warstwy kolorow + paleta CPAL z adaptacyjnym capem
const colr = core.buildFonts({ opentype, FeFont, colorfont }, new Uint8ClampedArray(png.data),
  png.width, png.height, grid, chars, { ...base, colr: true });
assert.ok(colr.colorized, 'colr: tablice kolorow obecne');
const f3 = opentype.parse(colr.ttf);
assert.ok(f3.numGlyphs > 96, 'colr: glify warstw dodane do fontu');
fs.writeFileSync('test/out/rainbow-colr.ttf', Buffer.from(colr.ttf));

// walidacja fontTools: COLR/CPAL obecne, paleta <= 64, warstwy A maja kontury
const { execSync } = require('child_process');
// interpreter z fontTools: B2F_PYTHON albo python3 z PATH; bez modulu
// walidacja jest pomijana z ostrzezeniem (reszta testu juz przeszla)
const py = process.env.B2F_PYTHON || 'python3';
const script = [
  "from fontTools.ttLib import TTFont",
  "f = TTFont('test/out/rainbow-colr.ttf')",
  "assert 'COLR' in f and 'CPAL' in f, 'brak COLR/CPAL'",
  "pal = f['CPAL'].palettes[0]",
  "assert len(pal) <= 64, 'paleta za duza: %d' % len(pal)",
  "cmap = f.getBestCmap()",
  "layers = f['COLR'].ColorLayers[cmap[65]]",
  "assert len(layers) > 0, 'A bez warstw'",
  "g = f['glyf']",
  "for l in layers: assert g[l.name].numberOfContours > 0, l.name",
  "print('fontTools: paleta %d kolorow, warstwy A: %d' % (len(pal), len(layers)))",
].join('\n');
let hasFontTools = false;
try { execSync(`${py} -c "import fontTools"`, { stdio: 'ignore' }); hasFontTools = true; } catch { /* brak modulu */ }
if (hasFontTools) {
  const out = execSync(`${py} -c "${script.replace(/"/g, '\\"')}"`).toString().trim();
  console.log(out);
} else {
  console.log(`UWAGA: ${py} bez fontTools - walidacja COLR pominieta (ustaw B2F_PYTHON)`);
}

console.log('OUTLINE OK - emoji-style, klasyczny fallback, bake scale i COLR poprawne');
