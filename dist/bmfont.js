/*
 * bitmap2font bmfont - eksport do formatu AngelCode BMFont (tekstowy .fnt
 * + atlas PNG), pakowany w zip (bez kompresji). Format konsumowany m.in.
 * przez Phaser, LibGDX, HaxeFlixel, MonoGame i konwertery Unity TMP.
 * Zaleznosci (encodePng, crc32) wstrzykiwane z modulu colorfont.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.B2F_BMFONT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Pakowanie atlasu (shelf packing) ---------------------------------
  // glyphs: Map<code, {data,w,h,...}|{advancePx}> -> pozycje w atlasie.
  // Sortowanie po wysokosci malejaco, polki od gory, 1 px odstepu.

  function packAtlas(glyphs) {
    const items = [];
    for (const [code, g] of glyphs) {
      if (g.data) items.push({ code, g });
    }
    items.sort((a, b) => b.g.h - a.g.h || a.code - b.code);

    const maxGlyphW = items.reduce((m, i) => Math.max(m, i.g.w), 1);
    // najmniejsza potega dwojki, w ktorej zmiesci sie pakowanie o rozsadnym
    // ksztalcie (docelowo szerokosc >= wysokosc)
    let atlasW = 64;
    while (atlasW < maxGlyphW + 2) atlasW *= 2;
    let placed;
    let atlasH;
    for (;;) {
      placed = tryPack(items, atlasW);
      atlasH = pow2(placed.height);
      if (atlasH <= atlasW || atlasW >= 4096) break;
      atlasW *= 2;
    }
    return { positions: placed.positions, w: atlasW, h: atlasH };
  }

  function pow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return Math.max(1, p);
  }

  function tryPack(items, atlasW) {
    const positions = new Map();
    let x = 1, y = 1, shelfH = 0;
    for (const { code, g } of items) {
      if (x + g.w + 1 > atlasW) {
        x = 1;
        y += shelfH + 1;
        shelfH = 0;
      }
      positions.set(code, { x, y });
      x += g.w + 1;
      shelfH = Math.max(shelfH, g.h);
    }
    return { positions, height: y + shelfH + 1 };
  }

  // --- Budowa atlasu RGBA ------------------------------------------------

  function buildAtlasRgba(glyphs, positions, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (const [code, pos] of positions) {
      const g = glyphs.get(code);
      for (let yy = 0; yy < g.h; yy++) {
        const src = yy * g.w * 4;
        const dst = ((pos.y + yy) * w + pos.x) * 4;
        out.set(g.data.subarray(src, src + g.w * 4), dst);
      }
    }
    return out;
  }

  // --- Tekstowy .fnt -----------------------------------------------------
  // opts: { name, cellH, base, glyphs: Map, positions, atlasW, atlasH, pageFile }

  function buildFnt(o) {
    const esc = (s) => String(s).replace(/"/g, "'");
    const lines = [];
    lines.push(
      `info face="${esc(o.name)}" size=${o.cellH} bold=0 italic=0 charset="" unicode=1 ` +
      'stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1 outline=0',
    );
    lines.push(
      `common lineHeight=${o.cellH} base=${o.base} scaleW=${o.atlasW} scaleH=${o.atlasH} ` +
      'pages=1 packed=0 alphaChnl=0 redChnl=4 greenChnl=4 blueChnl=4',
    );
    lines.push(`page id=0 file="${esc(o.pageFile)}"`);

    const codes = [...o.glyphs.keys()].sort((a, b) => a - b);
    lines.push(`chars count=${codes.length}`);
    for (const code of codes) {
      const g = o.glyphs.get(code);
      const pos = o.positions.get(code);
      const adv = Math.round(g.advancePx);
      if (!g.data || !pos) {
        lines.push(
          `char id=${code} x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 ` +
          `xadvance=${adv} page=0 chnl=15`,
        );
        continue;
      }
      // yoffset: odleglosc od gornej krawedzi linii do gory glifu (y w dol)
      const yoffset = o.base - g.topY;
      lines.push(
        `char id=${code} x=${pos.x} y=${pos.y} width=${g.w} height=${g.h} ` +
        `xoffset=${g.bearingX} yoffset=${yoffset} xadvance=${adv} page=0 chnl=15`,
      );
    }
    lines.push('kernings count=0');
    return lines.join('\n') + '\n';
  }

  // --- Minimalny zip (bez kompresji) ------------------------------------

  function makeZip(entries, crc32) {
    // stala data: 2026-08-05 12:00 w formacie DOS
    const dosTime = 12 << 11;
    const dosDate = ((2026 - 1980) << 9) | (8 << 5) | 5;
    const enc = new TextEncoder();

    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = e.data;
      const crc = crc32(data, 0, data.length);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);        // version needed
      lv.setUint16(8, 0, true);         // method: store
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      parts.push(local, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);

      offset += local.length + data.length;
    }

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const total = offset + cdSize + 22;
    const zip = new Uint8Array(total);
    let p = 0;
    for (const part of [...parts, ...central, eocd]) {
      zip.set(part, p);
      p += part.length;
    }
    return zip;
  }

  // --- API --------------------------------------------------------------
  // build({name, slug, cellH, base, glyphs}, deps {encodePng, crc32})
  // -> { fnt: string, png: Uint8Array, zip: Uint8Array }

  function build(o, deps) {
    const { positions, w, h } = packAtlas(o.glyphs);
    const rgba = buildAtlasRgba(o.glyphs, positions, w, h);
    const png = deps.encodePng(rgba, w, h);
    const pageFile = `${o.slug}_0.png`;
    const fnt = buildFnt({
      name: o.name, cellH: o.cellH, base: o.base,
      glyphs: o.glyphs, positions, atlasW: w, atlasH: h, pageFile,
    });
    const zip = makeZip([
      { name: `${o.slug}.fnt`, data: new TextEncoder().encode(fnt) },
      { name: pageFile, data: png },
    ], deps.crc32);
    return { fnt, png, zip, atlasW: w, atlasH: h };
  }

  return { build, packAtlas, buildFnt, makeZip };
});
