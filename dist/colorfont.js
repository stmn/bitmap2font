/*
 * bitmap2font colorfont - osadzanie kolorowych glifow (PNG z alpha) w TTF.
 * Buduje tablice CBDT/CBLC (Google) i sbix (Apple) i wstrzykuje je do gotowego
 * pliku sfnt z przeliczeniem checksumow. Czysty JS - dziala w node i przegladarce.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.B2F_COLORFONT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- CRC32 / Adler32 (PNG) --------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  // --- Minimalny enkoder PNG --------------------------------------------
  // RGBA 8-bit, zlib ze "stored" blokami deflate (bez kompresji - glify sa
  // malutkie, a unikamy zaleznosci). Wystarcza kazdemu dekoderowi PNG.

  function encodePng(rgba, w, h) {
    // dane rastrowe: kazdy wiersz poprzedzony bajtem filtra 0
    const raw = new Uint8Array(h * (1 + w * 4));
    for (let y = 0; y < h; y++) {
      const o = y * (1 + w * 4);
      raw[o] = 0;
      raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), o + 1);
    }
    // zlib: naglowek + bloki stored (max 65535) + adler
    const blocks = Math.max(1, Math.ceil(raw.length / 65535));
    const idat = new Uint8Array(2 + blocks * 5 + raw.length + 4);
    idat[0] = 0x78; idat[1] = 0x01;
    let p = 2;
    for (let i = 0; i < blocks; i++) {
      const s = i * 65535;
      const chunk = raw.subarray(s, Math.min(s + 65535, raw.length));
      idat[p++] = i === blocks - 1 ? 1 : 0;
      idat[p++] = chunk.length & 0xff;
      idat[p++] = chunk.length >>> 8;
      idat[p++] = ~chunk.length & 0xff;
      idat[p++] = (~chunk.length >>> 8) & 0xff;
      idat.set(chunk, p);
      p += chunk.length;
    }
    const ad = adler32(raw);
    idat[p++] = ad >>> 24; idat[p++] = (ad >>> 16) & 0xff;
    idat[p++] = (ad >>> 8) & 0xff; idat[p++] = ad & 0xff;

    const ihdr = new Uint8Array(13);
    const iv = new DataView(ihdr.buffer);
    iv.setUint32(0, w);
    iv.setUint32(4, h);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    // 10..12: compression/filter/interlace = 0

    const chunk = (type, data) => {
      const out = new Uint8Array(12 + data.length);
      const v = new DataView(out.buffer);
      v.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
      return out;
    };
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
    const total = parts.reduce((s, x) => s + x.length, 0);
    const png = new Uint8Array(total);
    let q = 0;
    for (const part of parts) { png.set(part, q); q += part.length; }
    return png;
  }

  // --- Budowa tablic ----------------------------------------------------
  // glyphs: Map<gid, { png: Uint8Array, w, h, bearingX, topY, advance }>
  // (bearingX / topY / advance w pikselach wzgledem baseline i origin glifu)

  function buildCBDT(numGlyphs, glyphs) {
    let size = 4;
    for (const g of glyphs.values()) size += 9 + g.png.length;
    const cbdt = new Uint8Array(size);
    const v = new DataView(cbdt.buffer);
    v.setUint16(0, 3); // majorVersion
    const offsets = new Uint32Array(numGlyphs + 1); // wzgledem imageDataOffset (=4)
    let p = 4;
    for (let gid = 0; gid < numGlyphs; gid++) {
      offsets[gid] = p - 4;
      const g = glyphs.get(gid);
      if (!g) continue;
      // format 17: smallGlyphMetrics + dataLen + png
      cbdt[p++] = g.h;
      cbdt[p++] = g.w;
      v.setInt8(p++, g.bearingX);
      v.setInt8(p++, g.topY);
      cbdt[p++] = g.advance;
      v.setUint32(p, g.png.length);
      p += 4;
      cbdt.set(g.png, p);
      p += g.png.length;
    }
    offsets[numGlyphs] = p - 4;
    return { cbdt, offsets };
  }

  function buildCBLC(numGlyphs, offsets, m) {
    // header(8) + BitmapSize(48) + IndexSubTableArray(8) + subtable(8 + offsety)
    const subLen = 8 + (numGlyphs + 1) * 4;
    const cblc = new Uint8Array(8 + 48 + 8 + subLen);
    const v = new DataView(cblc.buffer);
    v.setUint16(0, 3);          // majorVersion
    v.setUint32(4, 1);          // numSizes
    let p = 8;
    v.setUint32(p, 56);         // indexSubTableArrayOffset (8 + 48)
    v.setUint32(p + 4, 8 + subLen); // indexTablesSize
    v.setUint32(p + 8, 1);      // numberOfIndexSubTables
    // colorRef = 0
    const lineMetrics = (o) => {
      v.setInt8(o, m.ascenderPx);
      v.setInt8(o + 1, m.descenderPx);
      cblc[o + 2] = m.widthMax;
      v.setInt8(o + 4, 1); // caretSlopeDenominator (numerator = 0 pod o+3)
    };
    lineMetrics(p + 16); // hori
    lineMetrics(p + 28); // vert
    v.setUint16(p + 40, 0);             // startGlyphIndex
    v.setUint16(p + 42, numGlyphs - 1); // endGlyphIndex
    cblc[p + 44] = m.ppem;
    cblc[p + 45] = m.ppem;
    cblc[p + 46] = 32; // bitDepth
    v.setInt8(p + 47, 1); // flags: horizontal
    p = 56;
    v.setUint16(p, 0);              // firstGlyphIndex
    v.setUint16(p + 2, numGlyphs - 1);
    v.setUint32(p + 4, 8);          // additionalOffsetToIndexSubtable
    p += 8;
    v.setUint16(p, 1);   // indexFormat 1
    v.setUint16(p + 2, 17); // imageFormat 17
    v.setUint32(p + 4, 4);  // imageDataOffset w CBDT
    p += 8;
    for (let i = 0; i <= numGlyphs; i++) v.setUint32(p + i * 4, offsets[i]);
    return cblc;
  }

  function buildSbix(numGlyphs, glyphs, ppem) {
    let dataSize = 0;
    for (const g of glyphs.values()) dataSize += 8 + g.png.length;
    const strikeLen = 4 + (numGlyphs + 1) * 4 + dataSize;
    const sbix = new Uint8Array(12 + strikeLen);
    const v = new DataView(sbix.buffer);
    v.setUint16(0, 1);  // version
    v.setUint16(2, 1);  // flags
    v.setUint32(4, 1);  // numStrikes
    v.setUint32(8, 12); // strikeOffset[0]
    const s = 12;
    v.setUint16(s, ppem);
    v.setUint16(s + 2, 72); // ppi
    let p = s + 4 + (numGlyphs + 1) * 4;
    for (let gid = 0; gid < numGlyphs; gid++) {
      v.setUint32(s + 4 + gid * 4, p - s);
      const g = glyphs.get(gid);
      if (!g) continue;
      // delta wzgledem bboxa konturu (0, gdy PNG pokrywa sie z konturem)
      v.setInt16(p, g.sbixDx || 0);
      v.setInt16(p + 2, g.sbixDy || 0);
      sbix[p + 4] = 0x70; sbix[p + 5] = 0x6e; sbix[p + 6] = 0x67; sbix[p + 7] = 0x20; // 'png '
      sbix.set(g.png, p + 8);
      p += 8 + g.png.length;
    }
    v.setUint32(s + 4 + numGlyphs * 4, p - s);
    return sbix;
  }

  // --- sfnt: wstrzykniecie tablic i przeliczenie checksumow -------------

  function tableChecksum(bytes) {
    let sum = 0;
    const padded = (bytes.length + 3) & ~3;
    for (let i = 0; i < padded; i += 4) {
      sum = (sum
        + ((bytes[i] || 0) << 24 >>> 0)
        + ((bytes[i + 1] || 0) << 16)
        + ((bytes[i + 2] || 0) << 8)
        + (bytes[i + 3] || 0)) >>> 0;
    }
    return sum;
  }

  function injectTables(fontBuffer, newTables) {
    // ArrayBuffer albo (node) Buffer/TypedArray
    const src = fontBuffer instanceof Uint8Array
      ? fontBuffer
      : new Uint8Array(fontBuffer);
    const sv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const numTables = sv.getUint16(4);
    const tables = new Map(); // tag -> Uint8Array
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(src[o], src[o + 1], src[o + 2], src[o + 3]);
      const off = sv.getUint32(o + 8);
      const len = sv.getUint32(o + 12);
      tables.set(tag, src.slice(off, off + len));
    }
    for (const [tag, bytes] of Object.entries(newTables)) tables.set(tag, bytes);

    const tags = [...tables.keys()].sort();
    const n = tags.length;
    let entrySelector = 0;
    while (1 << (entrySelector + 1) <= n) entrySelector++;
    const searchRange = (1 << entrySelector) * 16;

    let offset = 12 + n * 16;
    const layout = tags.map(tag => {
      const bytes = tables.get(tag);
      const rec = { tag, bytes, offset, checksum: tableChecksum(bytes) };
      offset += (bytes.length + 3) & ~3;
      return rec;
    });

    const out = new Uint8Array(offset);
    const ov = new DataView(out.buffer);
    ov.setUint32(0, sv.getUint32(0)); // sfnt version (0x00010000)
    ov.setUint16(4, n);
    ov.setUint16(6, searchRange);
    ov.setUint16(8, entrySelector);
    ov.setUint16(10, n * 16 - searchRange);
    layout.forEach((rec, i) => {
      const o = 12 + i * 16;
      for (let k = 0; k < 4; k++) out[o + k] = rec.tag.charCodeAt(k);
      ov.setUint32(o + 4, rec.checksum);
      ov.setUint32(o + 8, rec.offset);
      ov.setUint32(o + 12, rec.bytes.length);
      out.set(rec.bytes, rec.offset);
    });

    // checkSumAdjustment w head: zerujemy, liczymy sume calosci, wpisujemy
    const head = layout.find(r => r.tag === 'head');
    if (head) {
      ov.setUint32(head.offset + 8, 0);
      const headIdx = layout.indexOf(head);
      ov.setUint32(12 + headIdx * 16 + 4, tableChecksum(out.subarray(head.offset, head.offset + head.bytes.length)));
      const total = tableChecksum(out);
      ov.setUint32(head.offset + 8, (0xb1b0afba - total) >>> 0);
    }
    return out.buffer;
  }

  // --- API --------------------------------------------------------------

  // opts: { numGlyphs, ppem, ascenderPx, descenderPx,
  //         glyphs: Map<gid, {png, w, h, bearingX, topY, advance}> }
  function injectColorTables(ttfBuffer, opts) {
    let widthMax = 0;
    for (const g of opts.glyphs.values()) widthMax = Math.max(widthMax, g.w);
    const { cbdt, offsets } = buildCBDT(opts.numGlyphs, opts.glyphs);
    const cblc = buildCBLC(opts.numGlyphs, offsets, {
      ppem: opts.ppem,
      ascenderPx: opts.ascenderPx,
      descenderPx: opts.descenderPx,
      widthMax,
    });
    const sbix = buildSbix(opts.numGlyphs, opts.glyphs, opts.ppem);
    return injectTables(ttfBuffer, { CBDT: cbdt, CBLC: cblc, sbix });
  }

  // COLR v0 + CPAL v0 - wektorowe warstwy kolorow (gidy z core)
  function injectColrTables(ttfBuffer, info) {
    const nB = info.baseRecords.length, nL = info.layerRecords.length;
    const colr = new Uint8Array(14 + nB * 6 + nL * 4);
    const cv = new DataView(colr.buffer);
    cv.setUint16(0, 0);
    cv.setUint16(2, nB);
    cv.setUint32(4, 14);
    cv.setUint32(8, 14 + nB * 6);
    cv.setUint16(12, nL);
    info.baseRecords.forEach((r, i) => {
      const o = 14 + i * 6;
      cv.setUint16(o, r.gid);
      cv.setUint16(o + 2, r.firstLayer);
      cv.setUint16(o + 4, r.numLayers);
    });
    info.layerRecords.forEach((r, i) => {
      const o = 14 + nB * 6 + i * 4;
      cv.setUint16(o, r.gid);
      cv.setUint16(o + 2, r.paletteIndex);
    });
    const nP = info.palette.length;
    const cpal = new Uint8Array(14 + nP * 4);
    const pv = new DataView(cpal.buffer);
    pv.setUint16(0, 0);
    pv.setUint16(2, nP);
    pv.setUint16(4, 1);
    pv.setUint16(6, nP);
    pv.setUint32(8, 14);
    pv.setUint16(12, 0);
    info.palette.forEach(([r, g, b, a], i) => {
      const o = 14 + i * 4; // BGRA
      cpal[o] = b; cpal[o + 1] = g; cpal[o + 2] = r; cpal[o + 3] = a;
    });
    return injectTables(ttfBuffer, { COLR: colr, CPAL: cpal });
  }

  return { encodePng, injectColorTables, injectColrTables, crc32 };
});
