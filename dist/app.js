/* bitmap2font - warstwa UI. Core pipeline w core.js, biblioteki w vendor/vendor.js. */
(function () {
  'use strict';
  const { opentype, FeFont } = window.B2F_VENDOR;
  const core = window.B2F_CORE;
  const colorfont = window.B2F_COLORFONT;
  const importers = window.B2F_IMPORTERS;

  const $ = (id) => document.getElementById(id);

  // --- Stan -------------------------------------------------------------

  let img = null;       // { rgba: Uint8ClampedArray, w, h }
  let lastResult = null; // wynik buildFonts
  let previewUrl = null;

  const defaultChars = (() => {
    let s = '';
    for (let c = 32; c <= 126; c++) s += String.fromCharCode(c);
    return s;
  })();
  $('chars').value = defaultChars;

  // --- Wczytywanie obrazu ----------------------------------------------

  const dropzone = $('dropzone');
  const fileInput = $('fileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });
  for (const el of [dropzone, document.body]) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    el.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
  }

  // Przykładowy arkusz: Press Start 2P (OFL), ASCII 32-126, siatka 16x6, baseline 0
  $('loadExample').addEventListener('click', (e) => {
    e.stopPropagation();
    importOverrides = null;
    setFontNameFrom('example.png');
    $('gridCols').value = 16; $('gridRows').value = 6;
    $('cellW').value = 8; $('cellH').value = 8; $('baseline').value = 0;
    $('mono').checked = false;
    $('chars').value = defaultChars;
    const image = new Image();
    image.onload = () => readImage(image);
    image.onerror = () => setStatus('error', 'Could not load the example sheet.');
    image.src = 'example.png';
  });

  // nazwa fontu: auto-wypelniana z nazwy pliku, ale user moze ja nadpisac w polu
  function setFontNameFrom(fileName) {
    const base = fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
    $('fontName').value = base || 'Bitmap Font';
  }

  function fontName() {
    return $('fontName').value.trim() || 'Bitmap Font';
  }

  function loadFile(file) {
    const nameLower = (file.name || '').toLowerCase();
    const isImage = (file.type && file.type.startsWith('image/'))
      || /\.(png|gif|webp|bmp|jpe?g)$/.test(nameLower);

    if (isImage && pendingBmfont) { loadBmfontAtlas(file); return; }

    if (isImage) {
      setFontNameFrom(file.name || '');
      importOverrides = null;
      autoGuessGrid = true; // nowy arkusz - sprobuj zgadnac siatke
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); readImage(image); };
      image.onerror = () => setStatus('error', 'Could not read that file - is it an image?');
      image.src = url;
      return;
    }

    // import gotowego fontu bitmapowego (BDF / BMFont .fnt / Windows FNT / FON)
    file.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      const kind = importers.sniff(bytes, file.name || '');
      try {
        if (kind === 'bdf') {
          applyImportedFont(importers.parseBdf(new TextDecoder().decode(bytes)), file.name);
        } else if (kind === 'winfnt') {
          applyImportedFont(importers.parseWinFnt(bytes), file.name);
        } else if (kind === 'fon') {
          applyImportedFont(importers.parseFon(bytes), file.name);
        } else if (kind === 'bmfont-text' || kind === 'bmfont-bin') {
          pendingBmfont = kind === 'bmfont-bin'
            ? importers.parseBmfontBinary(bytes)
            : importers.parseBmfontText(new TextDecoder().decode(bytes));
          pendingBmfontName = file.name;
          setStatus('warn', `BMFont descriptor loaded - now drop the atlas image (${pendingBmfont.pageFile || 'page PNG'}).`);
          toast('Now drop the atlas PNG');
        } else {
          setStatus('error', 'Unsupported file - drop a PNG sheet or a BDF / FNT / FON font.');
        }
      } catch (err) {
        setStatus('error', 'Import failed: ' + err.message);
      }
    });
  }

  function loadBmfontAtlas(file) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas');
      c.width = image.naturalWidth;
      c.height = image.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      try {
        const font = importers.attachAtlas(pendingBmfont, { rgba: d.data, w: c.width, h: c.height });
        applyImportedFont(font, pendingBmfontName);
      } catch (err) {
        setStatus('error', 'Import failed: ' + err.message);
      }
      pendingBmfont = null;
    };
    image.onerror = () => { setStatus('error', 'Could not read the atlas image.'); pendingBmfont = null; };
    image.src = url;
  }

  // zaimportowany font -> syntetyczny arkusz + parametry + overrides metryk
  function applyImportedFont(font, fileName) {
    const sheet = importers.buildSheet(font);
    setFontNameFrom(fileName || `${font.name}.png`);
    setGridMode('count');
    $('gridCols').value = sheet.cols;
    $('gridRows').value = sheet.rows;
    $('cellW').value = sheet.cellW;
    $('cellH').value = sheet.cellH;
    $('baseline').value = sheet.baseline;
    $('mono').checked = false;
    $('chars').value = sheet.chars;
    importOverrides = sheet.overrides;
    autoGuessGrid = false;
    const c = document.createElement('canvas');
    c.width = sheet.w;
    c.height = sheet.h;
    c.getContext('2d').putImageData(new ImageData(sheet.rgba, sheet.w, sheet.h), 0, 0);
    readImage(c);
    toast(`Imported ${font.name}: ${font.glyphs.length} glyphs`);
  }

  function readImage(image) {
    const c = document.createElement('canvas');
    c.width = image.naturalWidth || image.width;
    c.height = image.naturalHeight || image.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    img = { rgba: data.data, w: c.width, h: c.height };
    try { lastImageDataUrl = c.toDataURL('image/png'); } catch { lastImageDataUrl = null; }

    // auto-wlaczanie color fontu: jesli arkusz ma AA albo kolory, binaryzacja
    // by je zniszczyla - zaznaczamy checkbox (user moze nadpisac recznie);
    // przy przywracaniu sesji szanujemy zapisany stan checkboxa
    sheetRich = core.detectRichInk(img.rgba, img.w, img.h);
    if (suppressAutoColor) {
      suppressAutoColor = false;
    } else {
      const should = sheetRich.antialiased || sheetRich.multicolor;
      if ($('colorFont').checked !== should) {
        $('colorFont').checked = should;
        toast(should
          ? `Detected ${sheetRich.multicolor ? 'colors' : 'antialiasing'} in the sheet - color font enabled`
          : 'Plain 1-bit sheet - color font disabled');
      }
    }
    // auto-detekcja siatki dla nowo wgranego pliku: kandydaci-dzielniki
    // wymiarow oceniani po tym, ile tuszu przecinaja linie siatki
    if (autoGuessGrid) {
      autoGuessGrid = false;
      applyGridGuess(false);
    }

    dropzone.classList.add('compact');
    $('introHelp').hidden = true;
    $('canvasWrap').hidden = false;
    $('previewBlock').hidden = false;
    $('imgInfo').hidden = false;
    rebuild();
  }

  // zgadywanie siatki: z przycisku (reportFail=true) i przy wgraniu pliku
  function applyGridGuess(reportFail) {
    if (!img) return;
    const guess = core.guessGrid(img.rgba, img.w, img.h, $('chars').value.length || 0);
    if (guess && guess.confident) {
      setGridMode('count');
      $('gridCols').value = guess.cols;
      $('gridRows').value = guess.rows;
      toast(`Guessed grid: ${guess.cols}x${guess.rows} (cells ${guess.cellW}x${guess.cellH} px)`);
      scheduleRebuild();
    } else if (reportFail) {
      toast('Could not detect the grid confidently - adjust manually');
    }
  }

  // --- Sesja: parametry + bitmapa w localStorage -----------------------
  // Start zawsze czysty; jesli jest zapis, w dropzone pojawia sie przycisk
  // "load last session" przywracajacy formularz i obraz.

  const SESSION_KEY = 'b2f-session';
  let lastImageDataUrl = null;
  let sheetRich = { antialiased: false, multicolor: false };
  let suppressAutoColor = false;
  let autoGuessGrid = false;
  let importOverrides = null;   // Map code -> {originX, advancePx} z importu fontu
  let pendingBmfont = null;     // sparsowany .fnt czekajacy na atlas PNG
  let pendingBmfontName = '';

  // Sonda wsparcia kolorowych glifow: mikro-font z jednym czerwonym pikselem
  // przepuszczony przez nasz pipeline; jesli canvas widzi czerwien, przegladarka
  // renderuje CBDT/sbix. Pewne niezaleznie od zawartosci arkusza usera.
  let colorGlyphSupport = null; // null = jeszcze nie wiemy
  (function probeColorSupport() {
    try {
      const rgba = new Uint8ClampedArray(4 * 4 * 4);
      rgba[0] = 255; rgba[3] = 255; // (0,0) czerwony
      const res = core.buildFonts(
        { opentype, FeFont, colorfont }, rgba, 4, 4,
        { offsetX: 0, offsetY: 0, cellW: 4, cellH: 4, spacingX: 0, spacingY: 0 },
        'A',
        { name: 'B2FProbe', baseline: 0, threshold: 128, mono: true, letterSpacing: 0, spaceWidth: 1, colorFont: true },
      );
      const face = new FontFace('B2FProbe', res.ttf.slice(0));
      face.load().then(() => {
        document.fonts.add(face);
        requestAnimationFrame(() => {
          const c = document.createElement('canvas');
          c.width = 16;
          c.height = 16;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.font = "12px 'B2FProbe'";
          ctx.fillStyle = '#ffffff';
          ctx.fillText('A', 2, 12);
          const d = ctx.getImageData(0, 0, 16, 16).data;
          colorGlyphSupport = false;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 40 && d[i] > d[i + 1] + 40) { colorGlyphSupport = true; break; }
          }
          document.fonts.delete(face);
          if (img) rebuild(); // odswiez notke, jesli user zdazyl juz wgrac arkusz
        });
      }).catch(() => { /* sonda niedostepna - notki nie pokazujemy */ });
    } catch { /* jw. */ }
  })();

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => { el.hidden = true; }, 350);
    }, 3400);
  }

  function saveSession() {
    try {
      const data = { gridMode, params: {}, image: null };
      for (const id of paramIds) {
        const el = $(id);
        data.params[id] = el.type === 'checkbox' ? el.checked : el.value;
      }
      // limit ~2.5 MB - wieksze arkusze nie mieszcza sie w localStorage
      if (lastImageDataUrl && lastImageDataUrl.length < 2_500_000) data.image = lastImageDataUrl;
      if (importOverrides) data.overrides = [...importOverrides];
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch { /* pelny storage / tryb prywatny - trudno */ }
  }

  (function initSessionRestore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { /* uszkodzony zapis */ }
    if (!saved || !saved.image) return;
    const btn = $('loadLast');
    btn.hidden = false;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const [id, v] of Object.entries(saved.params || {})) {
        const el = $(id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v;
      }
      setGridMode(saved.gridMode === 'size' ? 'size' : 'count');
      if (saved.fontName) $('fontName').value = saved.fontName; // stare sesje
      importOverrides = Array.isArray(saved.overrides) ? new Map(saved.overrides) : null;
      suppressAutoColor = true; // zapisany stan checkboxa ma pierwszenstwo
      const image = new Image();
      image.onload = () => readImage(image);
      image.onerror = () => setStatus('error', 'Could not restore the saved image.');
      image.src = saved.image;
    });
  })();

  // --- Tooltipy (tippy.js) ---------------------------------------------
  if (window.B2F_TIPPY) {
    window.B2F_TIPPY('[data-tip]', {
      content: (el) => el.getAttribute('data-tip'),
      theme: 'b2f',
      animation: 'shift-away',
      maxWidth: 290,
      delay: [80, 40],
    });
    // klik w "i" nie moze zwijac akordeonu ani przelaczac checkboxa
    for (const b of document.querySelectorAll('.info-btn')) {
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    }
  }

  // auto-load przykładu do testów headless (?demo=1)
  if (new URLSearchParams(location.search).has('demo')) {
    window.addEventListener('load', () => $('loadExample').click());
  }

  // --- Odczyt parametrów ------------------------------------------------

  function num(id, min) { return Math.max(min, parseInt($(id).value, 10) || min); }

  // Tryb siatki: 'count' (liczba kolumn/wierszy) albo 'size' (rozmiar komórki w px)
  let gridMode = 'count';

  function setGridMode(mode) {
    if (img && mode !== gridMode) syncGridInputs(mode);
    gridMode = mode;
    $('modeCount').classList.toggle('active', mode === 'count');
    $('modeSize').classList.toggle('active', mode === 'size');
    $('fieldsCount').hidden = mode !== 'count';
    $('fieldsSize').hidden = mode !== 'size';
  }

  // przy przełączeniu trybu przelicza wartości, żeby siatka się nie zmieniła
  function syncGridInputs(newMode) {
    const g = readParams().grid;
    if (newMode === 'size') {
      $('cellW').value = g.cellW;
      $('cellH').value = g.cellH;
    } else {
      const layout = core.gridLayout(img.w, img.h, g);
      $('gridCols').value = Math.max(1, layout.cols);
      $('gridRows').value = Math.max(1, layout.rows);
    }
  }

  $('modeCount').addEventListener('click', () => { setGridMode('count'); scheduleRebuild(); });
  $('modeSize').addEventListener('click', () => { setGridMode('size'); scheduleRebuild(); });

  // dokladny rozmiar komórki z liczby kolumn/wierszy - moze wyjsc ulamkowy,
  // co jest bledem usera (arkusz pikselowy nie dzieli sie na 8.53 px)
  function cellFromCount(span, count, gap) {
    return (span + gap) / count - gap;
  }

  function readParams() {
    const offsetX = num('offsetX', 0), offsetY = num('offsetY', 0);
    const spacingX = num('spacingX', 0), spacingY = num('spacingY', 0);
    let cellW, cellH, fracWarn = null, draw = null;
    if (gridMode === 'count' && img) {
      const cols = num('gridCols', 1), rows = num('gridRows', 1);
      const exactW = cellFromCount(img.w - offsetX, cols, spacingX);
      const exactH = cellFromCount(img.h - offsetY, rows, spacingY);
      if (!Number.isInteger(exactW) || !Number.isInteger(exactH)) {
        fracWarn = `${cols}x${rows} splits ${img.w}x${img.h} px into `
          + `${exactW.toFixed(2)}x${exactH.toFixed(2)} px cells - the grid cuts through glyphs.`;
      }
      // siatka, ciecie i font ida za LITERALNYM podzialem (takze ulamkowym) -
      // zle wartosci daja spojnie rozjechany overlay i podglad
      draw = {
        cols, rows,
        cellW: exactW, cellH: exactH,
        stepX: exactW + spacingX, stepY: exactH + spacingY,
      };
      cellW = Math.max(1, exactW);
      cellH = Math.max(1, exactH);
    } else {
      cellW = num('cellW', 1);
      cellH = num('cellH', 1);
    }
    return {
      fracWarn, draw,
      grid: { cellW, cellH, offsetX, offsetY, spacingX, spacingY },
      chars: $('chars').value,
      opts: {
        notdefChar: Array.from($('notdefChar').value)[0] || '',
        name: fontName(),
        baseline: num('baseline', 0),
        threshold: num('threshold', 1),
        mono: $('mono').checked,
        letterSpacing: num('letterSpacing', 0),
        spaceWidth: num('spaceWidth', 1),
        colorFont: $('colorFont').checked,
        outlineFallback: $('outlineFallback').checked,
        bakeScale: parseInt($('bakeScale').value, 10) || 1,
        colr: $('colrTable').checked,
        overrides: importOverrides,
      },
    };
  }

  // --- Render canvasa z siatką -----------------------------------------

  function renderCanvas(grid, draw = null) {
    const canvas = $('canvas');
    const maxW = canvas.parentElement.clientWidth - 8 || 600;
    const scale = Math.max(1, Math.min(8, Math.floor(maxW / img.w)));
    canvas.width = img.w * scale;
    canvas.height = img.h * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // obraz
    const off = document.createElement('canvas');
    off.width = img.w; off.height = img.h;
    off.getContext('2d').putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
    // przezroczyste tlo arkusza pokazuje kolor panelu (.canvas-wrap),
    // zamiast wlasnej czarnej plachty
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    // siatka: w trybie count rysujemy literalny podzial z pol (takze bledny,
    // ulamkowy); w trybie size podzial wynikajacy z rozmiaru komorki
    const layout = core.gridLayout(img.w, img.h, grid);
    const d = draw ?? {
      cols: layout.cols, rows: layout.rows,
      cellW: grid.cellW, cellH: grid.cellH,
      stepX: layout.stepX, stepY: layout.stepY,
    };
    ctx.strokeStyle = 'rgba(240, 180, 41, 0.45)';
    ctx.lineWidth = 1;
    // zamykajace linie ostatniej kolumny/wiersza leza na krawedzi canvasa -
    // clamp do srodka, zeby byly widoczne
    for (let c = 0; c <= d.cols; c++) {
      for (let r = 0; r < d.rows; r++) {
        const x = Math.min(
          (grid.offsetX + c * d.stepX - (c === d.cols ? grid.spacingX : 0)) * scale,
          canvas.width - 1,
        );
        const y0 = (grid.offsetY + r * d.stepY) * scale;
        line(ctx, x + 0.5, y0, x + 0.5, y0 + d.cellH * scale);
      }
    }
    for (let r = 0; r <= d.rows; r++) {
      for (let c = 0; c < d.cols; c++) {
        const y = Math.min(
          (grid.offsetY + r * d.stepY - (r === d.rows ? grid.spacingY : 0)) * scale,
          canvas.height - 1,
        );
        const x0 = (grid.offsetX + c * d.stepX) * scale;
        line(ctx, x0, y + 0.5, x0 + d.cellW * scale, y + 0.5);
      }
    }
    const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(2));
    const leftX = img.w - grid.offsetX - layout.cols * layout.stepX + grid.spacingX;
    const leftY = img.h - grid.offsetY - layout.rows * layout.stepY + grid.spacingY;
    $('imgInfo').textContent =
      `${img.w}x${img.h} px - grid ${d.cols}x${d.rows} = ${d.cols * d.rows} cells of ${fmt(d.cellW)}x${fmt(d.cellH)} px - zoom ${scale}x` +
      (gridMode === 'size' && (leftX || leftY) ? ` - ${leftX}x${leftY} px unused` : '');
    return layout;
  }

  function line(ctx, x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // --- Budowa fontu (debounce) -----------------------------------------

  let timer = null;
  function scheduleRebuild() {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  }

  function rebuild() {
    if (!img) return;
    const { grid, chars, opts, fracWarn, draw } = readParams();
    const layout = renderCanvas(grid, draw);
    try {
      if (!chars.length) throw new Error('Character list is empty.');
      lastResult = core.buildFonts({ opentype, FeFont, colorfont }, img.rgba, img.w, img.h, grid, chars, opts);
      const parts = [`${lastResult.glyphCount} glyphs`];
      if (lastResult.colorized) parts.push('color glyphs in TTF');
      if (lastResult.colrLayers) parts.push(`${lastResult.colrLayers} COLR layers`);
      if (lastResult.notdefFrom !== null) parts.push('fallback glyph set');
      if (lastResult.emptyCells) parts.push(`${lastResult.emptyCells} empty cells`);
      $('outlineWrap').hidden = !$('colorFont').checked;
      $('bakeWrap').hidden = !$('colorFont').checked;
      $('colrWrap').hidden = !$('colorFont').checked;
      if (fracWarn) {
        setStatus('warn', fracWarn);
      } else if (opts.notdefChar && lastResult.notdefFrom === null) {
        setStatus('warn', `Fallback glyph "${opts.notdefChar}" is not in the character list - .notdef left empty. ${parts.join(', ')}.`);
      } else if (lastResult.truncated) {
        setStatus('warn', `Grid has ${layout.cols * layout.rows} cells but ${chars.length} characters given - extra characters skipped. ${parts.join(', ')}.`);
      } else {
        setStatus('', `Ready - ${parts.join(', ')}.`);
      }
      $('dlOtf').disabled = false;
      $('dlTtf').disabled = false;
      $('dlBmf').disabled = false;
      $('previewBlock').classList.remove('stale');
      // podglad z TTF - przy color foncie to on niesie kolorowe glify
      updatePreview(lastResult.ttf);
      saveSession();
    } catch (err) {
      lastResult = null;
      $('dlOtf').disabled = true;
      $('dlTtf').disabled = true;
      $('dlBmf').disabled = true;
      // w podgladzie zostal font z ostatniego udanego builda - usuwamy go
      // calkowicie (fallback na systemowy monospace), zeby niczego nie udawal
      previewGen++; // uniewaznia tez async load bedacy w locie
      if (currentFace) { document.fonts.delete(currentFace); currentFace = null; }
      $('previewText').style.fontFamily = '';
      $('previewBlock').classList.add('stale');
      $('outlineWrap').hidden = !$('colorFont').checked;
      $('bakeWrap').hidden = !$('colorFont').checked;
      $('colrWrap').hidden = !$('colorFont').checked;
      renderBitmapPreview();
      setStatus('error', err.message);
    }
  }

  function setStatus(kind, msg) {
    const el = $('status');
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.textContent = msg;
  }

  // --- Podgląd przez FontFace ------------------------------------------

  let currentFace = null;
  let previewGen = 0;
  function updatePreview(otfBuffer) {
    const gen = ++previewGen;
    const face = new FontFace('B2FPreview', otfBuffer.slice(0));
    face.load().then(() => {
      if (gen !== previewGen) return; // w międzyczasie powstał nowszy font
      if (currentFace) document.fonts.delete(currentFace);
      currentFace = face;
      document.fonts.add(face);
      $('previewText').style.fontFamily = "'B2FPreview', monospace";
      updateBaselineGuide();
      // przegladarki bez CBDT/sbix (np. Firefox) pokazuja w preview fallback
      // konturowy (m.in. bez wypieczonego AA) - notka pod podgladem,
      // plik i tak ma kolorowe glify
      const noColorHere = lastResult && lastResult.colorized && colorGlyphSupport === false
        && !$('bmpPreview').checked;
      $('previewNote').hidden = !noColorHere;
      if (noColorHere) {
        $('previewNoteText').textContent = $('outlineFallback').checked
          ? 'This browser previews the outline fallback - the TTF still contains color glyphs (Chrome, Godot and macOS render them).'
          : 'This browser cannot render color glyphs, and with Outline fallback off the font has no visible shapes here - enable the Embedded bitmaps preview (or re-check Outline fallback).';
      }
      syncBitmapPreviewUi();
    }).catch(() => setStatus('error', 'Generated font failed to load in the browser.'));
  }

  // Pozycja linii bazowej pierwszego wiersza: half-leading + ascender.
  // W generowanym foncie ascender+descender = 1000 upem, więc wystarczy
  // proporcja (cellH - baselinePx) / cellH.
  function updateBaselineGuide() {
    const guide = $('baselineGuide');
    guide.hidden = !$('showBaseline').checked || !img;
    if (guide.hidden) return;
    const { grid, opts } = readParams();
    const el = $('previewText');
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const lh = parseFloat(cs.lineHeight);
    const ascRatio = (grid.cellH - opts.baseline) / grid.cellH;
    guide.style.top = (parseFloat(cs.paddingTop) + (lh - fs) / 2 + fs * ascRatio) + 'px';
  }

  $('previewSize').addEventListener('input', () => {
    $('sizeVal').textContent = $('previewSize').value;
    $('previewText').style.fontSize = $('previewSize').value + 'px';
    updateBaselineGuide();
    renderBitmapPreview();
  });
  $('showBaseline').addEventListener('input', updateBaselineGuide);

  // --- Podglad "Embedded bitmaps": tekst skladany na canvasie wprost
  // z pikseli osadzonych w TTF - AA i kolory widoczne w kazdej przegladarce

  let bmpTouched = false; // user recznie przelaczyl - nie nadpisujemy auto-wyborem
  $('bmpPreview').addEventListener('input', () => {
    bmpTouched = true;
    renderBitmapPreview();
  });

  function syncBitmapPreviewUi() {
    const available = !!(lastResult && lastResult.colorized && lastResult.previewGlyphs);
    $('bmpPrevWrap').hidden = !available;
    if (!available) {
      $('bmpPreview').checked = false;
    } else if (!bmpTouched) {
      // auto: wlaczamy tam, gdzie przegladarka nie umie kolorowych glifow
      $('bmpPreview').checked = colorGlyphSupport === false;
    }
    renderBitmapPreview();
  }

  function renderBitmapPreview() {
    const on = !$('bmpPrevWrap').hidden && $('bmpPreview').checked
      && lastResult && lastResult.previewGlyphs;
    $('previewBitmap').hidden = !on;
    $('previewText').hidden = !!on;
    if (!on) return;

    const glyphs = lastResult.previewGlyphs;
    const m = lastResult.previewMetrics;
    // znak spoza fontu dostaje glif fallbacku (.notdef) - tak jak w silniku
    // bez font fallbacku; bez ustawionego fallbacku znak jest pomijany
    const notdef = lastResult.notdefFrom !== null ? glyphs.get(lastResult.notdefFrom) : null;
    const lookup = (ch) => glyphs.get(ch.codePointAt(0)) || notdef;
    // bitmapy skalujemy wylacznie calkowicie - ulamkowa skala z nearest-neighbor
    // duplikuje pojedyncze kolumny pikseli (nierowne grubosci liter)
    const scale = Math.max(1, Math.floor(parseInt($('previewSize').value, 10) / m.cellH));
    const text = $('previewText').textContent || '';

    // szerokosc linii w px arkusza
    let widthPx = 0;
    for (const ch of text) {
      const g = lookup(ch);
      widthPx += g ? g.advancePx : 0;
    }
    const canvas = $('previewCanvas');
    canvas.width = Math.max(1, Math.ceil(widthPx * scale));
    canvas.height = Math.max(1, Math.ceil(m.cellH * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const baselineY = m.ascenderPx * scale;

    let pen = 0;
    for (const ch of text) {
      const g = lookup(ch);
      if (!g) continue;
      if (g.data) {
        ctx.drawImage(
          glyphCanvas(g),
          (pen + g.bearingX) * scale,
          baselineY - g.topY * scale,
          g.w * scale,
          g.h * scale,
        );
      }
      pen += g.advancePx;
    }
  }

  // ImageData nie da sie skalowac przy rysowaniu - kazdy glif dostaje
  // maly canvas zrodlowy (cache na obiekcie glifu)
  function glyphCanvas(g) {
    if (!g.canvas) {
      const c = document.createElement('canvas');
      c.width = g.w;
      c.height = g.h;
      c.getContext('2d').putImageData(new ImageData(g.data, g.w, g.h), 0, 0);
      g.canvas = c;
    }
    return g.canvas;
  }

  // --- Pobieranie -------------------------------------------------------

  function fontSlug() {
    return fontName().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bitmap-font';
  }

  function downloadFile(buffer, filename, mime) {
    const blob = new Blob([buffer], { type: mime });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = filename;
    a.click();
  }
  const download = (buffer, ext) => downloadFile(buffer, fontSlug() + '.' + ext, 'font/' + ext);
  $('dlOtf').addEventListener('click', () => lastResult && download(lastResult.otf, 'otf'));
  $('dlTtf').addEventListener('click', () => lastResult && download(lastResult.ttf, 'ttf'));
  $('dlBmf').addEventListener('click', () => {
    if (!lastResult || !lastResult.previewGlyphs) return;
    const bm = window.B2F_BMFONT.build({
      name: fontName(),
      slug: fontSlug(),
      cellH: lastResult.previewMetrics.cellH,
      base: lastResult.previewMetrics.ascenderPx,
      glyphs: lastResult.previewGlyphs,
    }, { encodePng: colorfont.encodePng, crc32: colorfont.crc32 });
    downloadFile(bm.zip, fontSlug() + '-bmfont.zip', 'application/zip');
  });

  // --- Nasłuch zmian ----------------------------------------------------

  const paramIds = ['gridCols', 'gridRows', 'cellW', 'cellH', 'offsetX', 'offsetY', 'spacingX', 'spacingY',
    'chars', 'notdefChar', 'fontName', 'baseline', 'threshold', 'letterSpacing', 'spaceWidth', 'mono', 'colorFont', 'outlineFallback', 'bakeScale', 'colrTable'];
  for (const id of paramIds) {
    $(id).addEventListener('input', scheduleRebuild);
  }
  window.addEventListener('resize', () => { if (img) scheduleRebuild(); });
})();
