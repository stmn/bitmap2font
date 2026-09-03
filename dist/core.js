/*
 * bitmap2font core - pipeline bitmapa -> kontury -> font.
 * Działa w przeglądarce (globalne B2F_CORE) i w node (module.exports).
 * Zależności (opentype.js, fonteditor-core Font) są wstrzykiwane przez buildFonts(deps, ...),
 * żeby moduł nie zakładał środowiska.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.B2F_CORE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Binaryzacja -------------------------------------------------------

  function lumAt(rgba, i) {
    return 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }

  // Tryb tuszu: jeśli obraz ma przezroczystość, decyduje alpha; inaczej
  // luminancja z polaryzacją wykrytą po jasności ramki obrazu (tło = brzeg).
  function detectInk(rgba, w, h) {
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] < 250) return { hasAlpha: true, bgBright: false };
    }
    let border = 0, count = 0;
    for (let x = 0; x < w; x++) { border += lumAt(rgba, x) + lumAt(rgba, (h - 1) * w + x); count += 2; }
    for (let y = 0; y < h; y++) { border += lumAt(rgba, y * w) + lumAt(rgba, y * w + w - 1); count += 2; }
    return { hasAlpha: false, bgBright: border / count >= 128 };
  }

  // pokrycie 0..255 piksela i (ile "tuszu" w pikselu) - baza binaryzacji i AA
  function coverageAt(rgba, i, ink) {
    if (ink.hasAlpha) return rgba[i * 4 + 3];
    const l = lumAt(rgba, i);
    return ink.bgBright ? 255 - l : l;
  }

  // Czy arkusz niesie cos, co binaryzacja by zniszczyla: antyaliasing
  // (posrednie pokrycia) albo wiecej niz jeden kolor tuszu. Podstawa
  // auto-wlaczania color fontu.
  function detectRichInk(rgba, w, h) {
    const ink = detectInk(rgba, w, h);
    const n = w * h;
    let inkPx = 0, softPx = 0;
    const colors = new Map();
    for (let i = 0; i < n; i++) {
      const cov = coverageAt(rgba, i, ink);
      if (cov <= 8) continue;
      inkPx++;
      if (cov > 16 && cov < 240) softPx++;
      if (cov >= 200) {
        // kwantyzacja RGB do 3 bitow na kanal - odporna na szum
        const key = ((rgba[i * 4] >> 5) << 6) | ((rgba[i * 4 + 1] >> 5) << 3) | (rgba[i * 4 + 2] >> 5);
        colors.set(key, (colors.get(key) || 0) + 1);
      }
    }
    let majorColors = 0;
    for (const c of colors.values()) if (c > Math.max(12, inkPx * 0.01)) majorColors++;
    return {
      antialiased: inkPx > 0 && softPx > 12 && softPx / inkPx > 0.02,
      multicolor: majorColors >= 2,
    };
  }

  // Zgaduje siatke arkusza. Kandydaci: dzielniki szerokosci/wysokosci
  // (komorka musi dzielic obraz calkowicie); scoring: ile tuszu CIAGNIE SIE
  // przez linie siatki (piksel po obu stronach granicy) - poprawna siatka
  // przechodzi miedzy glifami, zla tnie litery. expectedCells preferuje
  // uklady mieszczace caly charset.
  function guessGrid(rgba, w, h, expectedCells) {
    const ink = detectInk(rgba, w, h);
    const on = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) on[i] = coverageAt(rgba, i, ink) > 64 ? 1 : 0;

    // crossX[x]: w ilu wierszach tusz przechodzi przez granice przed kolumna x
    const crossX = new Float64Array(w + 1);
    const crossY = new Float64Array(h + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        if (on[y * w + x - 1] && on[y * w + x]) crossX[x]++;
      }
    }
    for (let y = 1; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (on[(y - 1) * w + x] && on[y * w + x]) crossY[y]++;
      }
    }

    const divisors = (n) => {
      const out = [];
      for (let d = 4; d <= Math.min(96, Math.floor(n / 2)); d++) {
        if (n % d === 0) out.push(d);
      }
      return out;
    };

    let best = null;
    for (const cw of divisors(w)) {
      for (const ch of divisors(h)) {
        const cols = w / cw, rows = h / ch;
        if (cols < 2 || rows < 2 || cols * rows > 4096) continue;
        let cut = 0, len = 0;
        for (let k = 1; k < cols; k++) { cut += crossX[k * cw]; len += h; }
        for (let k = 1; k < rows; k++) { cut += crossY[k * ch]; len += w; }
        let score = len ? cut / len : 1;
        // priory: typowe rozmiary komorek i pojemnosc na charset
        if (![8, 16, 24, 32].includes(cw)) score += 0.003;
        if (![8, 16, 24, 32].includes(ch)) score += 0.003;
        if (expectedCells) {
          if (cols * rows < expectedCells) score += 0.08;
          else if (cols * rows > expectedCells * 4) score += 0.02;
        }
        if (!best || score < best.score) {
          best = { cols, rows, cellW: cw, cellH: ch, score };
        }
      }
    }
    if (!best) return null;
    return { ...best, confident: best.score <= 0.03 };
  }

  // rgba: Uint8ClampedArray (RGBA), zwraca Uint8Array 0/1 o rozmiarze w*h.
  function binarize(rgba, w, h, threshold) {
    const n = w * h;
    const out = new Uint8Array(n);
    const ink = detectInk(rgba, w, h);
    for (let i = 0; i < n; i++) out[i] = coverageAt(rgba, i, ink) >= threshold ? 1 : 0;
    return out;
  }

  // --- Siatka ------------------------------------------------------------

  function gridLayout(imgW, imgH, g) {
    const stepX = g.cellW + g.spacingX;
    const stepY = g.cellH + g.spacingY;
    const cols = Math.max(0, Math.floor((imgW - g.offsetX + g.spacingX) / stepX));
    const rows = Math.max(0, Math.floor((imgH - g.offsetY + g.spacingY) / stepY));
    return { cols, rows, stepX, stepY };
  }

  // Wycina komórkę idx (reading order) jako Uint8Array cw*ch z binarnej mapy.
  // Origin liczony z literalnego (moze ulamkowego) kroku siatki - zla liczba
  // kolumn daje realnie rozjechane ciecie, spojne z overlayem w UI.
  function sliceCell(bin, imgW, g, layout, idx) {
    const col = idx % layout.cols;
    const row = Math.floor(idx / layout.cols);
    const x0 = g.offsetX + Math.round(col * layout.stepX);
    const y0 = g.offsetY + Math.round(row * layout.stepY);
    const cw = Math.round(g.cellW);
    const ch = Math.round(g.cellH);
    const imgH = Math.floor(bin.length / imgW);
    const cell = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const sx = x0 + x, sy = y0 + y;
        cell[y * cw + x] = (sx < imgW && sy < imgH) ? bin[sy * imgW + sx] : 0;
      }
    }
    return cell;
  }

  // --- Trasowanie konturów ----------------------------------------------
  // Krawędzie pikseli "on" graniczące z "off" jako odcinki skierowane
  // (wnętrze po lewej), łączone w zamknięte pętle, potem redukcja punktów
  // współliniowych. Współrzędne w pikselach, y w dół.

  function traceContours(cell, w, h) {
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : cell[y * w + x];
    // klucz punktu -> lista segmentów zaczynających się w tym punkcie
    const segs = new Map();
    const addSeg = (x1, y1, x2, y2) => {
      const k = x1 + ',' + y1;
      if (!segs.has(k)) segs.set(k, []);
      segs.get(k).push([x1, y1, x2, y2]);
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!at(x, y)) continue;
        if (!at(x, y - 1)) addSeg(x, y, x + 1, y);         // góra: w prawo
        if (!at(x + 1, y)) addSeg(x + 1, y, x + 1, y + 1); // prawa: w dół
        if (!at(x, y + 1)) addSeg(x + 1, y + 1, x, y + 1); // dół: w lewo
        if (!at(x - 1, y)) addSeg(x, y + 1, x, y);         // lewa: w górę
      }
    }
    // łączenie w pętle
    const loops = [];
    for (const [, list] of segs) {
      while (list.length) {
        const start = list.pop();
        const loop = [[start[0], start[1]]];
        let cx = start[2], cy = start[3];
        while (cx !== start[0] || cy !== start[1]) {
          loop.push([cx, cy]);
          const k = cx + ',' + cy;
          const cand = segs.get(k);
          if (!cand || !cand.length) { loop.length = 0; break; } // niedomknięta (nie powinno wystąpić)
          const seg = cand.pop();
          cx = seg[2]; cy = seg[3];
        }
        if (loop.length >= 4) loops.push(simplify(loop));
      }
    }
    return loops;
  }

  // usuwa punkty współliniowe (osiowe odcinki)
  function simplify(pts) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      const colinear = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
      if (!colinear) out.push(b);
    }
    return out;
  }

  // --- Metryki glifu -----------------------------------------------------

  function glyphBounds(cell, w, h) {
    let minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cell[y * w + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { minX, maxX, minY, maxY };
  }

  // --- Budowa fontu ------------------------------------------------------

  // opts: { name, cellW, cellH, baseline, threshold, mono, letterSpacing, spaceWidth }
  // deps: { opentype, FeFont }
  // Zwraca { otf: ArrayBuffer, ttf: ArrayBuffer, glyphCount, emptyCells }
  function buildFonts(deps, rgba, imgW, imgH, grid, chars, opts) {
    const opentype = deps.opentype;
    const bin = binarize(rgba, imgW, imgH, opts.threshold);
    const layout = gridLayout(imgW, imgH, grid);
    const totalCells = layout.cols * layout.rows;
    if (totalCells === 0) throw new Error('Siatka nie mieści się w obrazie - sprawdź wymiary komórki.');
    const usable = Math.min(chars.length, totalCells);

    // wymiary komorki do metryk i tracingu - zaokraglone (ulamkowe wejscie
    // z trybu count wplywa tylko na origin ciecia w sliceCell/cellColorGlyph)
    const cellW = Math.round(grid.cellW);
    const cellH = Math.round(grid.cellH);
    const upem = 1000;
    const scale = upem / cellH;
    const baselinePx = opts.baseline;
    const toFontY = (py) => (cellH - py - baselinePx) * scale;

    // tryb emoji-style (colorFont bez outlineFallback): kolorowe glify maja
    // puste kontury, ale .notdef dostaje ramke - inaczej tablica glyf mialaby
    // zerowa dlugosc i sanitizery przegladarek odrzucaja caly font
    const emptyOutlines = opts.colorFont && opts.outlineFallback === false;
    const glyphs = [null]; // gid 0 = .notdef, budowany po petli (moze klonowac glif z listy)

    const seen = new Set();
    const meta = []; // dane do przebiegu color font
    let emptyCells = 0;
    for (let i = 0; i < usable; i++) {
      const ch = chars[i];
      const code = ch.codePointAt(0);
      if (seen.has(code)) continue;
      seen.add(code);

      const cell = sliceCell(bin, imgW, grid, layout, i);
      const bounds = glyphBounds(cell, cellW, cellH);
      const loops = bounds ? traceContours(cell, cellW, cellH) : [];

      let originX = 0; // px odejmowany od x (left bearing w trybie proporcjonalnym)
      let advancePx;
      if (opts.mono) {
        advancePx = cellW;
      } else if (!bounds) {
        emptyCells++;
        advancePx = opts.spaceWidth;
      } else {
        originX = bounds.minX;
        advancePx = (bounds.maxX - bounds.minX + 1) + opts.letterSpacing;
      }
      if (ch === ' ' && !opts.mono) advancePx = opts.spaceWidth;

      // import gotowego fontu: bearing i advance przychodza z pliku,
      // nie z auto-trimu (opts.overrides: Map code -> {originX, advancePx})
      const ov = opts.overrides && opts.overrides.get(code);
      if (ov) {
        originX = ov.originX;
        advancePx = ov.advancePx;
      }

      const path = new opentype.Path();
      // emptyOutlines: puste kontury jak w fontach emoji - bbox glifu
      // degeneruje sie do origin i kotwiczenie sbix jest jednoznaczne
      // we wszystkich rendererach
      for (const loop of emptyOutlines ? [] : loops) {
        path.moveTo(Math.round((loop[0][0] - originX) * scale), Math.round(toFontY(loop[0][1])));
        for (let p = 1; p < loop.length; p++) {
          path.lineTo(Math.round((loop[p][0] - originX) * scale), Math.round(toFontY(loop[p][1])));
        }
        path.close();
      }
      glyphs.push(new opentype.Glyph({
        name: glyphName(code), unicode: code,
        advanceWidth: Math.round(advancePx * scale), path,
      }));
      meta.push({ code, cellIdx: i, originX, advancePx, bounds, glyphIndex: glyphs.length - 1 });
    }

    // .notdef (gid 0): pokazywany przez silniki bez font fallbacku dla znakow
    // spoza cmap. opts.notdefChar wskazuje znak z listy, ktorego glif jest
    // klonowany pod gid 0 (kontur, advance, a nizej bitmapa i warstwy COLR);
    // bez wskazania - pusty kontur, w trybie emoji ramka (zeby glyf nie byl pusty)
    const notdefSrc = opts.notdefChar
      ? meta.find((m) => m.code === opts.notdefChar.codePointAt(0)) || null
      : null;
    const notdefPath = new opentype.Path();
    if (emptyOutlines) {
      const nw = Math.round(cellW * scale * 0.7);
      const nh = Math.round((cellH - baselinePx) * scale * 0.9);
      const t = Math.max(10, Math.round(scale));
      notdefPath.moveTo(0, 0); notdefPath.lineTo(nw, 0);
      notdefPath.lineTo(nw, nh); notdefPath.lineTo(0, nh); notdefPath.close();
      notdefPath.moveTo(t, t); notdefPath.lineTo(t, nh - t);
      notdefPath.lineTo(nw - t, nh - t); notdefPath.lineTo(nw - t, t); notdefPath.close();
    } else if (notdefSrc) {
      notdefPath.commands = glyphs[notdefSrc.glyphIndex].path.commands.slice();
    }
    glyphs[0] = new opentype.Glyph({
      name: '.notdef',
      advanceWidth: notdefSrc ? glyphs[notdefSrc.glyphIndex].advanceWidth : Math.round(cellW * scale),
      path: notdefPath,
    });

    // bitmapy glifow (oryginalne piksele z alpha) liczone ZAWSZE - korzysta
    // z nich podglad bitmapowy, eksport BMFont, a przy colorFont tablice CBDT/sbix
    const ink = detectInk(rgba, imgW, imgH);
    const glyphBitmaps = new Map();
    for (const m of meta) {
      const g = cellColorGlyph(rgba, imgW, grid, layout, m.cellIdx, ink);
      if (!g) { glyphBitmaps.set(m.code, { advancePx: m.advancePx }); continue; }
      glyphBitmaps.set(m.code, {
        data: g.data, w: g.w, h: g.h,
        minX: g.minX, minY: g.minY,
        bearingX: g.minX - m.originX,
        topY: cellH - g.minY - baselinePx,
        advancePx: m.advancePx,
        bounds: m.bounds,
      });
    }

    // COLR (opcja): wektorowe warstwy per skwantyzowany kolor - dodatkowe
    // glify (bez cmap) wpiete do fontu, tablice dopisywane po budowie TTF
    let colrInfo = null;
    if (opts.colorFont && opts.colr) {
      colrInfo = buildColrLayers(opentype, glyphs, meta, glyphBitmaps, scale, notdefSrc);
    }

    const font = new opentype.Font({
      familyName: opts.name || 'Bitmap Font',
      styleName: 'Regular',
      unitsPerEm: upem,
      ascender: Math.round((cellH - baselinePx) * scale),
      descender: -Math.round(baselinePx * scale) || -1,
      glyphs,
    });
    const otf = font.toArrayBuffer();
    const fe = deps.FeFont.create(otf.slice(0), { type: 'otf', hinting: false });
    let ttf = fe.write({ type: 'ttf', hinting: false, toBuffer: true });

    // color font: oryginalne piksele jako PNG per glif, osadzone w TTF
    // w tablicach CBDT/CBLC + sbix; kontury zostaja fallbackiem
    let colorized = false;
    if (opts.colorFont) {
      if (!deps.colorfont) throw new Error('Brak modułu colorfont w deps.');
      const bake = Math.max(1, Math.floor(opts.bakeScale) || 1);
      if (cellW * bake > 120 || cellH * bake > 120) {
        throw new Error(`Color font: cell x bake scale must stay within 120 px (now ${cellW * bake}x${cellH * bake}). Lower the bake scale.`);
      }
      const parsed = opentype.parse(ttf);
      const colorGlyphs = new Map();
      for (const m of meta) {
        const e = glyphBitmaps.get(m.code);
        if (!e || !e.data) continue;
        const gid = parsed.charToGlyphIndex(String.fromCodePoint(m.code));
        if (!gid) continue;
        // sbix: renderery kotwicza bitmape w rogu bboxa konturu z glyf,
        // a originOffset dokladaja jako przesuniecie - podajemy wiec delte
        // miedzy cropem PNG (z miekkimi pikselami AA) a bboxem konturu
        const gMaxY = e.minY + e.h - 1;
        // bake scale: bitmapy wypiekane w wielokrotnosci (nearest-neighbor),
        // wszystkie metryki pikselowe skaluja sie razem z nimi
        const up = upscaleRgba(e.data, e.w, e.h, bake);
        colorGlyphs.set(gid, {
          png: deps.colorfont.encodePng(up.data, up.w, up.h),
          w: up.w,
          h: up.h,
          bearingX: e.bearingX * bake,
          topY: e.topY * bake,
          advance: Math.min(255, Math.round(e.advancePx * bake)),
          sbixDx: (opts.outlineFallback === false
            ? e.bearingX
            : (m.bounds ? e.minX - m.bounds.minX : 0)) * bake,
          sbixDy: (opts.outlineFallback === false
            ? e.topY - e.h
            : (m.bounds ? m.bounds.maxY - gMaxY : 0)) * bake,
        });
      }
      // klon bitmapy pod gid 0 - CBDT/sbix indeksuja od zera, wiec bez zmian formatu
      if (notdefSrc) {
        const srcGid = parsed.charToGlyphIndex(String.fromCodePoint(notdefSrc.code));
        if (colorGlyphs.has(srcGid)) colorGlyphs.set(0, colorGlyphs.get(srcGid));
      }
      if (colorGlyphs.size) {
        ttf = deps.colorfont.injectColorTables(ttf, {
          numGlyphs: parsed.numGlyphs,
          ppem: cellH * bake,
          ascenderPx: (cellH - baselinePx) * bake,
          descenderPx: -baselinePx * bake,
          glyphs: colorGlyphs,
        });
        colorized = true;
      }
      if (colrInfo && parsed.numGlyphs === glyphs.length) {
        ttf = deps.colorfont.injectColrTables(ttf, colrInfo);
      }
    }

    return {
      otf, ttf,
      glyphCount: meta.length,
      colrLayers: colrInfo ? colrInfo.layerRecords.length : 0,
      emptyCells,
      notdefFrom: notdefSrc ? notdefSrc.code : null,
      truncated: chars.length > totalCells, colorized,
      previewGlyphs: glyphBitmaps,
      previewMetrics: { cellH, ascenderPx: cellH - baselinePx },
    };
  }

  // kwantyzacja koloru do palety COLR: poziomy sterowane parametrami
  // (domyslnie rgbShift 4 = 16 poziomow RGB, alpha po 8); rekonstrukcja
  // mapuje poziomy rownomiernie z powrotem na 0..255
  function quantColor(r, g, b, a, rgbShift, alphaLevels) {
    const rs = rgbShift || 4;
    const al = alphaLevels || 8;
    const rgbMax = (1 << (8 - rs)) - 1;
    const qr = r >> rs, qg = g >> rs, qb = b >> rs;
    const qa = Math.min(al - 1, Math.round(a * (al - 1) / 255));
    return {
      key: (qr << 20) | (qg << 12) | (qb << 4) | qa,
      rgba: [
        Math.round(qr * 255 / rgbMax),
        Math.round(qg * 255 / rgbMax),
        Math.round(qb * 255 / rgbMax),
        Math.round(qa * 255 / (al - 1)),
      ],
    };
  }

  // Buduje glify warstw COLR: dla kazdego glifu i kazdego koloru z palety
  // maska pikseli -> traceContours -> kontur w ukladzie fontu. Zwraca
  // { baseRecords, layerRecords, palette } z gidami = indeksami w `glyphs`.
  // notdefSrc: wpis meta, ktorego warstwy dostaje tez gid 0 (wlasny .notdef).
  function buildColrLayers(opentype, glyphs, meta, glyphBitmaps, scale, notdefSrc) {
    // dobor kwantyzacji: przebieg po wszystkich bitmapach z drobnymi
    // poziomami, a gdy paleta przekracza cap - kolejno grubsze poziomy,
    // zeby CPAL nie puchl na arkuszach gradientowych
    const PALETTE_CAP = 64;
    const quantSteps = [[4, 8], [5, 4], [6, 2]];
    let rgbShift = 4, alphaLevels = 8;
    for (const [rs, al] of quantSteps) {
      rgbShift = rs; alphaLevels = al;
      const seen = new Set();
      for (const e of glyphBitmaps.values()) {
        if (!e || !e.data) continue;
        for (let i = 0; i < e.w * e.h; i++) {
          const a = e.data[i * 4 + 3];
          if (a < 16) continue;
          seen.add(quantColor(e.data[i * 4], e.data[i * 4 + 1], e.data[i * 4 + 2], a, rs, al).key);
        }
      }
      if (seen.size <= PALETTE_CAP) break;
    }

    const palette = [];
    const palIndex = new Map();
    const baseRecords = [];
    const layerRecords = [];

    for (const m of meta) {
      const e = glyphBitmaps.get(m.code);
      if (!e || !e.data) continue;
      const local = new Map();
      for (let i = 0; i < e.w * e.h; i++) {
        const a = e.data[i * 4 + 3];
        if (a < 16) continue;
        const q = quantColor(e.data[i * 4], e.data[i * 4 + 1], e.data[i * 4 + 2], a, rgbShift, alphaLevels);
        if (!local.has(q.key)) local.set(q.key, q.rgba);
      }
      const firstLayer = layerRecords.length;
      for (const [key, rgba] of local) {
        const mask = new Uint8Array(e.w * e.h);
        for (let i = 0; i < e.w * e.h; i++) {
          const a = e.data[i * 4 + 3];
          if (a < 16) continue;
          if (quantColor(e.data[i * 4], e.data[i * 4 + 1], e.data[i * 4 + 2], a, rgbShift, alphaLevels).key === key) mask[i] = 1;
        }
        const loops = traceContours(mask, e.w, e.h);
        if (!loops.length) continue;
        const path = new opentype.Path();
        for (const loop of loops) {
          path.moveTo(Math.round((e.bearingX + loop[0][0]) * scale), Math.round((e.topY - loop[0][1]) * scale));
          for (let p = 1; p < loop.length; p++) {
            path.lineTo(Math.round((e.bearingX + loop[p][0]) * scale), Math.round((e.topY - loop[p][1]) * scale));
          }
          path.close();
        }
        if (!palIndex.has(key)) {
          palIndex.set(key, palette.length);
          palette.push(rgba);
        }
        layerRecords.push({ gid: glyphs.length, paletteIndex: palIndex.get(key) });
        glyphs.push(new opentype.Glyph({
          name: `layer${glyphs.length}`,
          advanceWidth: Math.round(m.advancePx * scale),
          path,
        }));
      }
      const numLayers = layerRecords.length - firstLayer;
      if (numLayers > 0) baseRecords.push({ gid: m.glyphIndex, firstLayer, numLayers });
    }
    if (notdefSrc) {
      const src = baseRecords.find((r) => r.gid === notdefSrc.glyphIndex);
      if (src) baseRecords.push({ ...src, gid: 0 });
    }
    if (!baseRecords.length) return null;
    baseRecords.sort((a, b) => a.gid - b.gid);
    return { baseRecords, layerRecords, palette };
  }

  // powiekszenie RGBA nearest-neighborem (bake scale color fontu)
  function upscaleRgba(data, w, h, k) {
    if (k <= 1) return { data, w, h };
    const W = w * k, H = h * k;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const sy = (y / k) | 0;
      for (let x = 0; x < W; x++) {
        const si = (sy * w + ((x / k) | 0)) * 4;
        const di = (y * W + x) * 4;
        out[di] = data[si]; out[di + 1] = data[si + 1];
        out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
      }
    }
    return { data: out, w: W, h: H };
  }

  // wycinek komórki w RGBA przyciety do tuszu, z alpha znormalizowana
  // wg trybu (alpha wprost albo pokrycie z luminancji)
  function cellColorGlyph(rgba, imgW, grid, layout, idx, ink) {
    const col = idx % layout.cols;
    const row = Math.floor(idx / layout.cols);
    const x0 = grid.offsetX + Math.round(col * layout.stepX);
    const y0 = grid.offsetY + Math.round(row * layout.stepY);
    const cw = Math.round(grid.cellW);
    const ch = Math.round(grid.cellH);
    const imgH = Math.floor(rgba.length / 4 / imgW);
    const inImg = (x, y) => x < imgW && y < imgH;
    let minX = cw, minY = ch, maxX = -1, maxY = -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (inImg(x0 + x, y0 + y) && coverageAt(rgba, (y0 + y) * imgW + (x0 + x), ink) > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inImg(x0 + minX + x, y0 + minY + y)) continue;
        const si = (y0 + minY + y) * imgW + (x0 + minX + x);
        const di = (y * w + x) * 4;
        data[di] = rgba[si * 4];
        data[di + 1] = rgba[si * 4 + 1];
        data[di + 2] = rgba[si * 4 + 2];
        data[di + 3] = ink.hasAlpha ? rgba[si * 4 + 3] : coverageAt(rgba, si, ink);
      }
    }
    return { data, w, h, minX, minY };
  }

  function glyphName(code) {
    if (code >= 0x21 && code <= 0x7e) return String.fromCodePoint(code);
    return 'uni' + code.toString(16).toUpperCase().padStart(4, '0');
  }

  return { binarize, detectRichInk, guessGrid, gridLayout, sliceCell, traceContours, glyphBounds, buildFonts };
});
