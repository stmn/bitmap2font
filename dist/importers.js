/*
 * bitmap2font importers - wczytywanie gotowych fontow bitmapowych:
 * BDF (X11), BMFont .fnt (tekstowy i binarny) + atlas PNG, Windows .FON/.FNT.
 * Kazdy parser zwraca wspolna strukture:
 *   { name, ascent, descent, glyphs: [{ code, w, h, rgba|null, bearingX, topY, advance }] }
 * (topY = gora bitmapy w px NAD baseline; rgba = Uint8ClampedArray w*h*4)
 * buildSheet() sklada z tego syntetyczny arkusz + parametry dla pipeline'u.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.B2F_IMPORTERS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Rozpoznawanie formatu --------------------------------------------

  function sniff(bytes, fileName) {
    const name = (fileName || '').toLowerCase();
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64));
    if (head.startsWith('STARTFONT')) return 'bdf';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes[2] === 0x46 && bytes[3] === 3) return 'bmfont-bin';
    if (/^\s*(info|<\?xml|<font)/.test(head) && (head.includes('info') || head.includes('<font'))) return 'bmfont-text';
    if (bytes[0] === 0x4d && bytes[1] === 0x5a) return 'fon'; // MZ
    const ver = bytes[0] | (bytes[1] << 8);
    if ((ver === 0x0200 || ver === 0x0300) && name.endsWith('.fnt')) return 'winfnt';
    if (name.endsWith('.bdf')) return 'bdf';
    return null;
  }

  // --- BDF ---------------------------------------------------------------

  function parseBdf(text) {
    const lines = text.split(/\r?\n/);
    let name = 'BDF Font';
    let ascent = null, descent = null;
    let fbb = null; // [w, h, ox, oy]
    const glyphs = [];
    let cur = null, inBitmap = false, rows = [];

    for (const line of lines) {
      const [kw, ...rest] = line.trim().split(/\s+/);
      if (inBitmap) {
        if (kw === 'ENDCHAR') {
          finishChar();
          inBitmap = false;
          cur = null;
        } else if (kw) {
          rows.push(kw);
        }
        continue;
      }
      switch (kw) {
        case 'FAMILY_NAME': name = rest.join(' ').replace(/"/g, '') || name; break;
        case 'FONT_ASCENT': ascent = parseInt(rest[0], 10); break;
        case 'FONT_DESCENT': descent = parseInt(rest[0], 10); break;
        case 'FONTBOUNDINGBOX': fbb = rest.map(Number); break;
        case 'STARTCHAR': cur = { code: -1, bbx: null, dwidth: null }; break;
        case 'ENCODING': if (cur) cur.code = parseInt(rest[0], 10); break;
        case 'DWIDTH': if (cur) cur.dwidth = parseInt(rest[0], 10); break;
        case 'BBX': if (cur) cur.bbx = rest.map(Number); break;
        case 'BITMAP': if (cur) { inBitmap = true; rows = []; } break;
      }
    }

    function finishChar() {
      if (!cur || cur.code < 0 || !cur.bbx) return;
      const [w, h, ox, oy] = cur.bbx;
      const rgba = w > 0 && h > 0 ? new Uint8ClampedArray(w * h * 4) : null;
      if (rgba) {
        for (let y = 0; y < h; y++) {
          const hex = rows[y] || '';
          for (let x = 0; x < w; x++) {
            const nib = parseInt(hex[x >> 2] || '0', 16);
            if ((nib >> (3 - (x & 3))) & 1) {
              const i = (y * w + x) * 4;
              rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 255;
            }
          }
        }
      }
      glyphs.push({
        code: cur.code, w, h, rgba,
        bearingX: ox,
        topY: oy + h,
        advance: cur.dwidth ?? (fbb ? fbb[0] : w),
      });
    }

    if (ascent === null || descent === null) {
      // fallback z bounding boxa: oy to (ujemny) descent
      const oy = fbb ? fbb[3] : 0;
      const hh = fbb ? fbb[1] : 8;
      if (descent === null) descent = Math.max(0, -oy);
      if (ascent === null) ascent = hh - descent;
    }
    if (!glyphs.length) throw new Error('BDF: no glyphs found');
    return { name, ascent, descent, glyphs };
  }

  // --- BMFont (.fnt tekstowy / binarny) + atlas RGBA ---------------------
  // Zwraca {meta} bez pikseli; attachAtlas() wycina glify z RGBA atlasu.

  function parseBmfontText(text) {
    const chars = [];
    let face = 'BMFont', base = 0, lineHeight = 0, pageFile = null;
    const attr = (line) => {
      const out = {};
      for (const m of line.matchAll(/(\w+)=("([^"]*)"|[^\s]+)/g)) {
        out[m[1]] = m[3] !== undefined ? m[3] : m[2];
      }
      return out;
    };
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('info')) face = attr(t).face || face;
      else if (t.startsWith('common')) {
        const a = attr(t);
        base = parseInt(a.base, 10);
        lineHeight = parseInt(a.lineHeight, 10);
      } else if (t.startsWith('page')) pageFile = attr(t).file || pageFile;
      else if (t.startsWith('char ')) {
        const a = attr(t);
        chars.push({
          code: parseInt(a.id, 10),
          x: parseInt(a.x, 10), y: parseInt(a.y, 10),
          w: parseInt(a.width, 10), h: parseInt(a.height, 10),
          xoffset: parseInt(a.xoffset, 10), yoffset: parseInt(a.yoffset, 10),
          advance: parseInt(a.xadvance, 10), page: parseInt(a.page || '0', 10),
        });
      }
    }
    if (!chars.length) throw new Error('BMFont: no chars found');
    return { name: face, base, lineHeight, pageFile, chars };
  }

  function parseBmfontBinary(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 4;
    let face = 'BMFont', base = 0, lineHeight = 0, pageFile = null;
    const chars = [];
    while (p < bytes.length) {
      const blockType = bytes[p];
      const size = v.getUint32(p + 1, true);
      const s = p + 5;
      if (blockType === 1) {
        // info: fontSize i16, bity, charset, stretch, aa, padding[4], spacing[2], outline, nazwa
        let np = s + 14;
        let str = '';
        while (bytes[np] !== 0) str += String.fromCharCode(bytes[np++]);
        face = str || face;
      } else if (blockType === 2) {
        lineHeight = v.getUint16(s, true);
        base = v.getUint16(s + 2, true);
      } else if (blockType === 3) {
        let str = '';
        let np = s;
        while (bytes[np] !== 0) str += String.fromCharCode(bytes[np++]);
        pageFile = str;
      } else if (blockType === 4) {
        for (let cp = s; cp + 20 <= s + size; cp += 20) {
          chars.push({
            code: v.getUint32(cp, true),
            x: v.getUint16(cp + 4, true), y: v.getUint16(cp + 6, true),
            w: v.getUint16(cp + 8, true), h: v.getUint16(cp + 10, true),
            xoffset: v.getInt16(cp + 12, true), yoffset: v.getInt16(cp + 14, true),
            advance: v.getInt16(cp + 16, true), page: bytes[cp + 18],
          });
        }
      }
      p = s + size;
    }
    if (!chars.length) throw new Error('BMFont: no chars found');
    return { name: face, base, lineHeight, pageFile, chars };
  }

  // atlas: {rgba, w, h} -> pelna struktura wspolna
  function attachAtlas(meta, atlas) {
    const glyphs = meta.chars.map((c) => {
      let rgba = null;
      if (c.w > 0 && c.h > 0) {
        rgba = new Uint8ClampedArray(c.w * c.h * 4);
        for (let y = 0; y < c.h; y++) {
          const src = ((c.y + y) * atlas.w + c.x) * 4;
          rgba.set(atlas.rgba.subarray(src, src + c.w * 4), y * c.w * 4);
        }
      }
      return {
        code: c.code, w: c.w, h: c.h, rgba,
        bearingX: c.xoffset,
        topY: meta.base - c.yoffset,
        advance: c.advance,
      };
    });
    return {
      name: meta.name,
      ascent: meta.base,
      descent: Math.max(0, meta.lineHeight - meta.base),
      glyphs,
    };
  }

  // --- Windows FNT / FON -------------------------------------------------

  function parseWinFnt(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = v.getUint16(0, true);
    if (version !== 0x0200 && version !== 0x0300) throw new Error('FNT: unsupported version');
    const type = v.getUint16(66, true);
    if (type & 1) throw new Error('FNT: vector fonts are not supported');
    const ascent = v.getUint16(74, true);
    const pixHeight = v.getUint16(88, true);
    const firstChar = bytes[95], lastChar = bytes[96];
    let face = 'Windows Font';
    const faceOff = v.getUint32(105, true);
    if (faceOff > 0 && faceOff < bytes.length) {
      let s = '';
      let p = faceOff;
      while (bytes[p] !== 0 && p < bytes.length) s += String.fromCharCode(bytes[p++]);
      if (s) face = s;
    }
    const entrySize = version === 0x0300 ? 6 : 4;
    const tableOff = version === 0x0300 ? 148 : 118;
    const glyphs = [];
    for (let c = firstChar; c <= lastChar; c++) {
      const e = tableOff + (c - firstChar) * entrySize;
      const w = v.getUint16(e, true);
      const off = version === 0x0300 ? v.getUint32(e + 2, true) : v.getUint16(e + 2, true);
      if (w === 0) continue;
      const rgba = new Uint8ClampedArray(w * pixHeight * 4);
      // uklad: kolejne bajtowe kolumny, w kazdej pixHeight bajtow (wiersze)
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < pixHeight; y++) {
          const b = bytes[off + (x >> 3) * pixHeight + y];
          if ((b >> (7 - (x & 7))) & 1) {
            const i = (y * w + x) * 4;
            rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 255;
          }
        }
      }
      glyphs.push({ code: c, w, h: pixHeight, rgba, bearingX: 0, topY: ascent, advance: w });
    }
    if (!glyphs.length) throw new Error('FNT: no glyphs found');
    return { name: face, ascent, descent: pixHeight - ascent, glyphs };
  }

  function parseFon(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint16(0, true) !== 0x5a4d) throw new Error('FON: not an executable');
    const ne = v.getUint32(60, true);
    if (v.getUint16(ne, true) !== 0x454e) throw new Error('FON: not an NE executable');
    const resOff = ne + v.getUint16(ne + 36, true);
    const shift = v.getUint16(resOff, true);
    let p = resOff + 2;
    for (;;) {
      const typeId = v.getUint16(p, true);
      if (typeId === 0) break;
      const count = v.getUint16(p + 2, true);
      p += 8;
      for (let i = 0; i < count; i++) {
        if (typeId === 0x8008) { // RT_FONT
          const off = v.getUint16(p, true) << shift;
          const len = v.getUint16(p + 2, true) << shift;
          try {
            return parseWinFnt(bytes.subarray(off, off + len));
          } catch { /* sprobuj kolejnego zasobu */ }
        }
        p += 12;
      }
    }
    throw new Error('FON: no bitmap font resource found');
  }

  // --- Synteza arkusza dla pipeline'u ------------------------------------
  // Zwraca { rgba, w, h, cols, rows, cellW, cellH, baseline, chars, overrides }
  // overrides: Map code -> { originX, advancePx } (bearing i advance z pliku)

  function buildSheet(font) {
    const glyphs = font.glyphs
      .filter((g) => g.code >= 32 && g.code <= 0xffff)
      .sort((a, b) => a.code - b.code);
    if (!glyphs.length) throw new Error('Imported font has no usable glyphs');

    let ascent = font.ascent, descent = font.descent, minBearing = 0, maxRight = 1;
    for (const g of glyphs) {
      ascent = Math.max(ascent, g.topY);
      descent = Math.max(descent, g.h - g.topY);
      minBearing = Math.min(minBearing, g.bearingX);
      maxRight = Math.max(maxRight, Math.max(g.advance, g.bearingX + g.w));
    }
    const pad = -minBearing;
    const cellW = maxRight + pad + 1;
    const cellH = ascent + descent;
    const cols = Math.min(16, glyphs.length);
    const rows = Math.ceil(glyphs.length / cols);

    const w = cols * cellW, h = rows * cellH;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const overrides = new Map();
    let chars = '';
    glyphs.forEach((g, i) => {
      chars += String.fromCodePoint(g.code);
      overrides.set(g.code, { originX: pad, advancePx: g.advance });
      if (!g.rgba) return;
      const cx = (i % cols) * cellW + pad + g.bearingX;
      const cy = Math.floor(i / cols) * cellH + (ascent - g.topY);
      for (let y = 0; y < g.h; y++) {
        const ty = cy + y;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < g.w; x++) {
          const tx = cx + x;
          if (tx < 0 || tx >= w) continue;
          const si = (y * g.w + x) * 4, di = (ty * w + tx) * 4;
          rgba[di] = g.rgba[si];
          rgba[di + 1] = g.rgba[si + 1];
          rgba[di + 2] = g.rgba[si + 2];
          rgba[di + 3] = g.rgba[si + 3];
        }
      }
    });

    return { rgba, w, h, cols, rows, cellW, cellH, baseline: descent, chars, overrides, name: font.name };
  }

  return { sniff, parseBdf, parseBmfontText, parseBmfontBinary, attachAtlas, parseWinFnt, parseFon, buildSheet };
});
