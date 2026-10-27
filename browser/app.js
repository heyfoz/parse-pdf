/**
 * pdfharvest - browser edition.
 *
 * Everything runs client-side: pdf.js pulls the text layer and the embedded
 * images, and tesseract.js OCRs any page that has no usable text plus each
 * extracted image. No file ever leaves the machine.
 */

import { mergePdfFiles } from './merge.js';

// Loading the OCR/extraction engine is independent of PDF merging.
let pdfjsLib;

/* ------------------------------------------------------------------ state */

const state = {
  files: [],          // { id, file, status }
  docs: [],           // extraction results
  active: 0,
  view: 'transcript',
  render: 'formatted',   // formatted | markdown
  running: false,
  cancel: false,
  logLines: [],
  scheduler: null,
  schedulerLang: null,
  merged: null,
  mergeAbort: null,
};

const $ = (id) => document.getElementById(id);
const OCR_WORKERS = 2;
const libraryLoads = new Map();

function loadLibrary(url, name) {
  if (globalThis[name]) return Promise.resolve(globalThis[name]);
  if (!libraryLoads.has(url)) {
    const loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve(globalThis[name]);
      script.onerror = () => {
        libraryLoads.delete(url);
        script.remove();
        reject(new Error(`Could not load ${name}. Check your connection and try again.`));
      };
      document.head.appendChild(script);
    });
    libraryLoads.set(url, loading);
  }
  return libraryLoads.get(url);
}

/* ----------------------------------------------------------------- helpers */

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1900);
}

function log(message) {
  const stamp = new Date().toLocaleTimeString();
  state.logLines.push(`[${stamp}] ${message}`);
  if (state.logLines.length > 800) state.logLines.shift();
  const box = $('log');
  if (box) { box.textContent = state.logLines.join('\n'); box.scrollTop = box.scrollHeight; }
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function setStage(text, pct) {
  $('stage').textContent = text;
  if (typeof pct === 'number') $('bar').firstElementChild.style.width = `${Math.min(100, pct)}%`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeStem(name) {
  return name.replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'document';
}

const normalise = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const meaningfulChars = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length;

async function sha1(buffer) {
  const digest = await crypto.subtle.digest('SHA-1', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* --------------------------------------------------------------- text layer */

/**
 * Rebuild readable lines from pdf.js text items.
 * Items carry no line breaks, so we infer them from baseline jumps and insert
 * spaces where there is a horizontal gap the PDF encoded as positioning.
 */
function textFromContent(content) {
  const lines = [];
  let line = '';
  let lastX = null, lastY = null, lastW = 0;

  // Dropping empty flushes matters: a baseline jump and pdf.js's own hasEOL
  // marker both fire at a line end, and pushing twice doubles every newline.
  const flush = () => {
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    line = '';
    lastX = null;
  };

  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const size = item.height || 10;

    if (lastY !== null) {
      const drop = Math.abs(y - lastY);
      if (drop > size * 0.5) {
        const paragraph = drop > size * 1.8;   // a wider gap is a real break
        flush();
        if (paragraph && lines.length && lines[lines.length - 1] !== '') lines.push('');
      }
    }

    if (lastX !== null) {
      const gap = x - (lastX + lastW);
      if (gap > size * 0.18 && !line.endsWith(' ') && !item.str.startsWith(' ')) line += ' ';
    }

    line += item.str;
    lastX = x; lastY = y; lastW = item.width || 0;

    if (item.hasEOL) flush();
  }
  if (line.trim()) lines.push(line.replace(/\s+$/, ''));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------ image decode */

function imageToCanvas(img) {
  const width = img.width, height = img.height;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Recent pdf.js hands back an ImageBitmap for most images.
  if (img.bitmap) { ctx.drawImage(img.bitmap, 0, 0); return canvas; }
  if (!img.data) return null;

  const out = ctx.createImageData(width, height);
  const dst = out.data;
  const src = img.data;

  if (img.kind === 3) {                       // RGBA_32BPP
    dst.set(src.subarray(0, dst.length));
  } else if (img.kind === 2) {                // RGB_24BPP
    for (let i = 0, j = 0; j < dst.length; i += 3, j += 4) {
      dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; dst[j + 3] = 255;
    }
  } else if (img.kind === 1) {                // GRAYSCALE_1BPP, packed MSB-first
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const j = (y * width + x) * 4;
        dst[j] = dst[j + 1] = dst[j + 2] = v; dst[j + 3] = 255;
      }
    }
  } else {
    return null;
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

const canvasToBlob = (canvas, type = 'image/png') =>
  new Promise((resolve) => canvas.toBlob(resolve, type));

function resolveImageObject(page, name) {
  // pdf.js prefixes cross-page ("global") objects with g_.
  const stores = name.startsWith('g_')
    ? [page.commonObjs, page.objs]
    : [page.objs, page.commonObjs];
  for (const store of stores) {
    if (!store) continue;
    try { if (store.has(name)) return store.get(name); } catch { /* not resolved yet */ }
  }
  return null;
}

/* ------------------------------------------------------------------- OCR */

async function getScheduler(lang) {
  const Tesseract = await loadLibrary(
    'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js', 'Tesseract');
  if (state.scheduler && state.schedulerLang === lang) return state.scheduler;

  if (state.scheduler) {
    try { await state.scheduler.terminate(); } catch { /* ignore */ }
    state.scheduler = null;
  }

  setStage(`Loading OCR engine (${lang})… first run downloads language data`, 3);
  log(`initialising OCR: ${lang} x${OCR_WORKERS}`);

  const scheduler = Tesseract.createScheduler();
  for (let i = 0; i < OCR_WORKERS; i++) {
    const worker = await Tesseract.createWorker(lang, 1);
    scheduler.addWorker(worker);
  }
  state.scheduler = scheduler;
  state.schedulerLang = lang;
  log('OCR engine ready');
  return scheduler;
}

async function ocr(scheduler, imageLike) {
  const { data } = await scheduler.addJob('recognize', imageLike);
  return { text: (data.text || '').trim(), confidence: data.confidence ?? -1 };
}

/* ------------------------------------------------------------- extraction */

function options() {
  return {
    ocrMode: $('ocrMode').value,
    lang: $('lang').value,
    dpi: Number($('dpi').value),
    extractImages: $('doImages').checked,
    ocrImages: $('ocrImages').checked,
    savePages: $('savePages').checked,
    minPx: Number($('minPx').value) || 0,
    minChars: 24,
  };
}

async function extractDocument(entry, opts, onProgress) {
  const data = new Uint8Array(await entry.file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

  const doc = {
    name: entry.file.name,
    pageCount: pdf.numPages,
    pages: [],
    images: [],
    pageRenders: [],
    warnings: [],
    ocrPages: 0,
  };

  const needOcr = opts.ocrMode !== 'off';
  const scheduler = needOcr ? await getScheduler(opts.lang) : null;
  const seenHashes = new Map();
  const scale = opts.dpi / 72;

  for (let n = 1; n <= pdf.numPages; n++) {
    if (state.cancel) throw new Error('Cancelled');
    onProgress(`page ${n} of ${pdf.numPages}`, n, pdf.numPages);

    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale });

    const content = await page.getTextContent();
    const embedded = textFromContent(content);
    const hasText = meaningfulChars(embedded) >= opts.minChars;

    const record = {
      number: n,
      text: embedded,
      embedded,
      ocrText: '',
      source: hasText ? 'embedded' : 'empty',
      confidence: -1,
    };

    // Render the page when we need pixels: for OCR, or to keep as an export.
    let canvas = null;
    const wantsPageOcr = needOcr && (opts.ocrMode === 'force' || !hasText);
    if (wantsPageOcr || opts.savePages) {
      canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
      }).promise;
    } else {
      // Rendering also populates page.objs, which image extraction reads from.
      if (opts.extractImages) {
        const tiny = page.getViewport({ scale: 0.1 });
        const scratch = document.createElement('canvas');
        scratch.width = Math.max(1, Math.floor(tiny.width));
        scratch.height = Math.max(1, Math.floor(tiny.height));
        await page.render({ canvasContext: scratch.getContext('2d'), viewport: tiny }).promise;
      }
    }

    if (opts.savePages && canvas) {
      doc.pageRenders.push({ page: n, blob: await canvasToBlob(canvas) });
    }

    // --- embedded images -------------------------------------------------
    const pageImages = [];
    if (opts.extractImages) {
      try {
        const ops = await page.getOperatorList();
        const wanted = new Set([
          pdfjsLib.OPS.paintImageXObject,
          pdfjsLib.OPS.paintJpegXObject,
          pdfjsLib.OPS.paintImageXObjectRepeat,
        ].filter((v) => v !== undefined));

        const names = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (wanted.has(ops.fnArray[i])) {
            const name = ops.argsArray[i]?.[0];
            if (typeof name === 'string' && !names.includes(name)) names.push(name);
          }
        }

        for (const name of names) {
          if (state.cancel) throw new Error('Cancelled');
          let raw;
          try { raw = resolveImageObject(page, name); } catch { raw = null; }
          if (!raw) continue;

          const imgCanvas = imageToCanvas(raw);
          if (!imgCanvas) continue;
          if (Math.max(imgCanvas.width, imgCanvas.height) < opts.minPx) continue;

          const blob = await canvasToBlob(imgCanvas);
          if (!blob) continue;

          const hash = await sha1(await blob.arrayBuffer());
          if (seenHashes.has(hash)) {
            const first = seenHashes.get(hash);
            if (!first.alsoOnPages.includes(n)) first.alsoOnPages.push(n);
            continue;
          }

          const record = {
            page: n,
            index: pageImages.length + 1,
            width: imgCanvas.width,
            height: imgCanvas.height,
            blob,
            url: URL.createObjectURL(blob),
            size: blob.size,
            ocrText: '',
            confidence: -1,
            alsoOnPages: [],
            isPageScan: false,
          };
          record.filename = `p${String(n).padStart(3, '0')}-img${String(record.index).padStart(2, '0')}.png`;
          seenHashes.set(hash, record);
          pageImages.push(record);
          doc.images.push(record);
        }
      } catch (err) {
        doc.warnings.push(`Page ${n}: image extraction failed (${err.message})`);
      }
    }

    // A lone image matching the page's aspect ratio on a text-less page is the
    // scan itself -- we already OCR the render, so skip a duplicate pass.
    if (!hasText && pageImages.length === 1) {
      const only = pageImages[0];
      const pageAspect = viewport.width / viewport.height;
      const imgAspect = only.width / only.height;
      if (Math.abs(imgAspect - pageAspect) / pageAspect < 0.12) only.isPageScan = true;
    }

    // --- OCR -------------------------------------------------------------
    const jobs = [];
    if (wantsPageOcr && canvas) {
      jobs.push(ocr(scheduler, canvas).then((r) => {
        record.ocrText = r.text;
        record.confidence = r.confidence;
        if (r.text) {
          if (!embedded) { record.text = r.text; record.source = 'ocr'; }
          else { record.source = 'embedded+ocr'; if (opts.ocrMode === 'force') record.text = r.text; }
        }
      }));
    }
    if (needOcr && opts.ocrImages) {
      for (const image of pageImages) {
        if (image.isPageScan) continue;
        jobs.push(ocr(scheduler, image.blob).then((r) => {
          image.ocrText = r.text;
          image.confidence = r.confidence;
        }).catch((err) => doc.warnings.push(`Image OCR failed: ${err.message}`)));
      }
    }

    if (jobs.length) {
      onProgress(`page ${n} of ${pdf.numPages} — OCR (${jobs.length} job${jobs.length > 1 ? 's' : ''})`, n, pdf.numPages);
      await Promise.all(jobs);
    }

    doc.pages.push(record);
    page.cleanup();
  }

  doc.ocrPages = doc.pages.filter((p) => p.source.includes('ocr')).length;
  await pdf.destroy();
  return doc;
}

/* ------------------------------------------------------------- transcripts */

function transcriptFor(doc) {
  const out = [`# ${doc.name}`, ''];
  out.push(`**Pages:** ${doc.pageCount}  •  **Images:** ${doc.images.length}`);
  if (doc.ocrPages) out.push(`**OCR'd pages:** ${doc.ocrPages}`);
  out.push('');

  const byPage = new Map();
  for (const image of doc.images) {
    if (!byPage.has(image.page)) byPage.set(image.page, []);
    byPage.get(image.page).push(image);
  }

  for (const page of doc.pages) {
    out.push(`## Page ${page.number}`);
    const tag = { ocr: '_(text recovered by OCR)_', 'embedded+ocr': '_(embedded text + OCR)_', empty: '_(no text found)_' }[page.source];
    if (tag) out.push(tag);
    out.push('');
    out.push(page.text.trim() || '_[no text on this page]_');
    out.push('');

    const pageNorm = normalise(page.text);
    for (const image of byPage.get(page.number) || []) {
      if (image.isPageScan || !image.ocrText.trim()) continue;
      const imgNorm = normalise(image.ocrText);
      if (imgNorm && pageNorm && pageNorm.includes(imgNorm)) continue;
      out.push(`### Image text — ${image.filename}`);
      out.push('');
      out.push(image.ocrText.trim());
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

const plainTextFor = (doc) =>
  doc.pages.map((p) => p.text.trim()).filter(Boolean).join('\n\n');

function combinedTranscript() {
  if (state.docs.length === 1) return transcriptFor(state.docs[0]);
  const pages = state.docs.reduce((n, d) => n + d.pageCount, 0);
  const images = state.docs.reduce((n, d) => n + d.images.length, 0);
  const head = [
    `# Combined transcript — ${state.docs.length} documents`,
    '',
    `**Documents:** ${state.docs.length}  •  **Pages:** ${pages}  •  **Images:** ${images}`,
    '',
    ...state.docs.map((d, i) => `${i + 1}. ${d.name} — ${d.pageCount} pages, ${d.images.length} images`),
    '',
  ].join('\n');
  return head + `\n${'='.repeat(72)}\n\n` +
    state.docs.map(transcriptFor).join(`\n\n${'-'.repeat(72)}\n\n`);
}

const combinedPlainText = () =>
  state.docs.map((d) => plainTextFor(d)).filter(Boolean).join(`\n\n${'-'.repeat(72)}\n\n`);

// state.active === ALL means the merged view across every document.
const ALL = -1;
const currentDoc = () =>
  state.active === ALL ? null : state.docs[Math.min(state.active, state.docs.length - 1)];

/* ------------------------------------------------------- document model */

/**
 * Build a structured block list from the extraction results.
 *
 * Both the formatted preview and the .docx export render from this, so what you
 * see on screen and what lands in Word cannot drift apart.
 */
function buildBlocks(docs, merged) {
  const out = [];
  const meta = (runs) => out.push({ t: 'meta', runs });

  if (merged && docs.length > 1) {
    const pages = docs.reduce((n, d) => n + d.pageCount, 0);
    const images = docs.reduce((n, d) => n + d.images.length, 0);
    out.push({ t: 'h1', text: `Combined transcript — ${docs.length} documents` });
    meta([
      { text: 'Documents: ', b: true }, { text: String(docs.length) },
      { text: '   •   Pages: ', b: true }, { text: String(pages) },
      { text: '   •   Images: ', b: true }, { text: String(images) },
    ]);
    docs.forEach((d, i) =>
      out.push({ t: 'li', text: `${i + 1}. ${d.name} — ${d.pageCount} pages, ${d.images.length} images` }));
    out.push({ t: 'rule' });
  }

  docs.forEach((doc, index) => {
    if (index > 0) out.push({ t: 'pagebreak' });

    out.push({ t: 'h1', text: doc.name });
    const runs = [
      { text: 'Pages: ', b: true }, { text: String(doc.pageCount) },
      { text: '   •   Images: ', b: true }, { text: String(doc.images.length) },
    ];
    if (doc.ocrPages) {
      runs.push({ text: "   •   OCR'd pages: ", b: true }, { text: String(doc.ocrPages) });
    }
    meta(runs);

    if (doc.failed) {
      out.push({ t: 'note', text: doc.warnings.join(' ') || 'Extraction failed.' });
      return;
    }

    const byPage = new Map();
    for (const image of doc.images) {
      if (!byPage.has(image.page)) byPage.set(image.page, []);
      byPage.get(image.page).push(image);
    }

    for (const page of doc.pages) {
      out.push({ t: 'h2', text: `Page ${page.number}` });
      const tag = {
        ocr: 'text recovered by OCR',
        'embedded+ocr': 'embedded text + OCR',
        empty: 'no text found',
      }[page.source];
      if (tag) out.push({ t: 'note', text: tag });

      const body = page.text.trim();
      if (body) {
        for (const para of body.split(/\n{2,}/)) {
          if (para.trim()) out.push({ t: 'p', text: para.trim() });
        }
      } else {
        out.push({ t: 'note', text: '[no text on this page]' });
      }

      const pageNorm = normalise(page.text);
      for (const image of byPage.get(page.number) || []) {
        if (image.isPageScan) continue;
        out.push({ t: 'img', image });
        const text = image.ocrText.trim();
        if (!text) continue;
        const imgNorm = normalise(text);
        if (imgNorm && pageNorm && pageNorm.includes(imgNorm)) continue;
        out.push({ t: 'h3', text: `Text found in ${image.filename}` });
        for (const para of text.split(/\n{2,}/)) {
          if (para.trim()) out.push({ t: 'p', text: para.trim() });
        }
      }
    }
  });

  return out;
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function blocksToHtml(blocks) {
  const parts = [];
  for (const block of blocks) {
    switch (block.t) {
      case 'h1': parts.push(`<h1>${escapeHtml(block.text)}</h1>`); break;
      case 'h2': parts.push(`<h2>${escapeHtml(block.text)}</h2>`); break;
      case 'h3': parts.push(`<h3>${escapeHtml(block.text)}</h3>`); break;
      case 'meta':
        parts.push(`<p class="doc-meta">${block.runs
          .map((r) => (r.b ? `<strong>${escapeHtml(r.text)}</strong>` : escapeHtml(r.text)))
          .join('')}</p>`);
        break;
      case 'li': parts.push(`<p class="doc-li">${escapeHtml(block.text)}</p>`); break;
      case 'note': parts.push(`<p class="doc-note">${escapeHtml(block.text)}</p>`); break;
      case 'p': parts.push(`<p>${escapeHtml(block.text)}</p>`); break;
      case 'rule': parts.push('<hr>'); break;
      case 'pagebreak': parts.push('<hr class="doc-break">'); break;
      case 'img':
        parts.push(
          `<figure><img src="${block.image.url}" alt="${escapeHtml(block.image.filename)}" loading="lazy">` +
          `<figcaption>${escapeHtml(block.image.filename)} — ${block.image.width}×${block.image.height}</figcaption></figure>`);
        break;
    }
  }
  return parts.join('\n');
}

/* ---------------------------------------------------------- .docx export */

const EMU_PER_INCH = 914400;
const CONTENT_WIDTH_EMU = Math.round(6.5 * EMU_PER_INCH);   // Letter minus 1" margins
const EMU_PER_PX = 9525;

// Word refuses the whole file if a stray control byte reaches the XML, and OCR
// output routinely contains form feeds.
const XML_BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const xmlText = (value) =>
  String(value)
    .replace(XML_BAD, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Line breaks inside a paragraph are meaningful in PDF text, so they become
// real <w:br/> elements rather than being swallowed by the XML.
const wRun = (text, bold) => {
  const pr = bold ? '<w:rPr><w:b/></w:rPr>' : '';
  const body = String(text).split(/\r?\n/)
    .map((line) => `<w:t xml:space="preserve">${xmlText(line)}</w:t>`)
    .join('<w:br/>');
  return `<w:r>${pr}${body}</w:r>`;
};

const wPara = (style, runs) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs}</w:p>`;

function wImage(relId, id, width, height, name) {
  const scale = Math.min(1, CONTENT_WIDTH_EMU / (width * EMU_PER_PX));
  const cx = Math.round(width * EMU_PER_PX * scale);
  const cy = Math.round(height * EMU_PER_PX * scale);
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="${xmlText(name)}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${xmlText(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="200"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="52"/><w:color w:val="C2410C"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/>
      <w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="E5E0DA"/></w:pBdr></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="9A3412"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1F2937"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="C2410C"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="DocMeta">
    <w:name w:val="Doc Meta"/><w:basedOn w:val="Normal"/>
    <w:rPr><w:sz w:val="20"/><w:color w:val="6B7280"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="DocNote">
    <w:name w:val="Doc Note"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="100"/></w:pPr>
    <w:rPr><w:i/><w:sz w:val="20"/><w:color w:val="6B7280"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Caption">
    <w:name w:val="caption"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr>
    <w:rPr><w:i/><w:sz w:val="18"/><w:color w:val="6B7280"/></w:rPr>
  </w:style>
</w:styles>`;

/** Build a real .docx (OOXML in a zip) from the shared block model. */
async function buildDocx(blocks, includeImages = true) {
  const JSZip = await loadLibrary('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', 'JSZip');
  const zip = new JSZip();
  const body = [];
  const rels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
  ];
  const word = zip.folder('word');
  const media = word.folder('media');
  let imageNumber = 0;
  let first = true;

  for (const block of blocks) {
    switch (block.t) {
      case 'h1':
        body.push(wPara(first ? 'Title' : 'Heading1', wRun(block.text)));
        first = false;
        break;
      case 'h2': body.push(wPara('Heading2', wRun(block.text))); break;
      case 'h3': body.push(wPara('Heading3', wRun(block.text))); break;
      case 'meta':
        body.push(wPara('DocMeta', block.runs.map((r) => wRun(r.text, r.b)).join('')));
        break;
      case 'li': body.push(wPara('DocMeta', wRun(block.text))); break;
      case 'note': body.push(wPara('DocNote', wRun(block.text))); break;
      case 'p': body.push(wPara(null, wRun(block.text))); break;
      case 'rule':
        body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9C9C3"/></w:pBdr></w:pPr></w:p>');
        break;
      case 'pagebreak':
        body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
      case 'img': {
        if (!includeImages) break;
        imageNumber += 1;
        const id = `rIdImg${imageNumber}`;
        const name = `image${imageNumber}.png`;
        media.file(name, block.image.blob);
        rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
        body.push(wImage(id, imageNumber + 100, block.image.width, block.image.height, name));
        body.push(wPara('Caption', wRun(`${block.image.filename} — ${block.image.width}x${block.image.height}`)));
        break;
      }
    }
  }

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);

  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  word.folder('_rels').file('document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);

  word.file('styles.xml', DOCX_STYLES);

  word.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>
<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
</w:sectPr></w:body></w:document>`);

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  });
}

/* -------------------------------------------------------------------- run */

async function run() {
  if (state.running || !state.files.length) return;
  state.running = true;
  state.cancel = false;
  state.docs = [];
  state.logLines = [];

  $('runBtn').disabled = true;
  $('cancelBtn').disabled = false;
  $('progressWrap').classList.remove('hidden');
  renderQueue();
  try {
    pdfjsLib ??= await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  } catch (error) {
    state.running = false;
    $('cancelBtn').disabled = true;
    setStage('Could not load the extraction engine. Check your connection and try again.');
    renderQueue();
    return;
  }

  const opts = options();
  const total = state.files.length;
  log(`starting: ${total} PDF(s), ocr=${opts.ocrMode}, lang=${opts.lang}, ${opts.dpi} DPI`);

  for (let i = 0; i < state.files.length; i++) {
    if (state.cancel) break;
    const entry = state.files[i];
    entry.status = 'busy';
    renderQueue();

    const base = (i / total) * 100;
    const span = 100 / total;

    try {
      log(`→ ${entry.file.name}`);
      const doc = await extractDocument(entry, opts, (text, page, pages) => {
        setStage(`[${i + 1}/${total}] ${entry.file.name} — ${text}`, base + span * (page / pages));
      });
      state.docs.push(doc);
      entry.status = 'done';
      log(`   done: ${doc.pageCount} pages, ${doc.images.length} images, ${doc.ocrPages} OCR'd`);
      for (const w of doc.warnings) log(`   warning: ${w}`);
    } catch (err) {
      entry.status = state.cancel ? 'idle' : 'err';
      log(`   ERROR: ${err.message}`);
      if (!state.cancel) {
        state.docs.push({
          name: entry.file.name, pageCount: 0, pages: [], images: [],
          pageRenders: [], warnings: [`Failed: ${err.message}`], ocrPages: 0, failed: true,
        });
      }
    }
    renderQueue();
    renderResults();
  }

  // With several PDFs the merged view is almost always what you want first.
  if (state.docs.length > 1) state.active = ALL;

  setStage(state.cancel ? 'Cancelled.' : 'Done.', 100);
  log(state.cancel ? 'cancelled' : 'all documents finished');
  state.running = false;
  $('runBtn').disabled = false;
  $('cancelBtn').disabled = true;
  renderResults();
  renderQueue();
  if (!state.cancel) toast(`Extracted ${state.docs.length} document${state.docs.length > 1 ? 's' : ''}`);
}

function requestPdfPassword(name, attempt, signal) {
  if (signal?.aborted) return Promise.resolve(null);
  const dialog = $('pdfPasswordDialog');
  $('pdfPasswordPrompt').textContent = attempt
    ? `That password did not work for ${name}. Please try again.`
    : `${name} needs its opening password.`;
  $('pdfPassword').value = '';
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    const abort = () => dialog.close('cancel');
    dialog.addEventListener('close', () => {
      signal?.removeEventListener('abort', abort);
      const password = dialog.returnValue === 'unlock' ? $('pdfPassword').value : null;
      $('pdfPassword').value = '';
      resolve(password);
    }, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    dialog.showModal();
    $('pdfPassword').focus();
  });
}

async function mergeQueue() {
  if (state.running || state.files.length < 2) return;
  const files = state.files.map((entry) => entry.file);
  state.running = true;
  state.cancel = false;
  state.mergeAbort = new AbortController();
  $('cancelBtn').disabled = false;
  $('progressWrap').classList.remove('hidden');
  $('mergeStatus').textContent = 'Merging…';
  renderQueue();
  try {
    const result = await mergePdfFiles(files, {
      cancelled: () => state.cancel,
      signal: state.mergeAbort.signal,
      requestPassword: requestPdfPassword,
      progress: (done, total, name) => {
        const message = `Merging ${done}/${total}: ${name}`;
        $('mergeStatus').textContent = message;
        setStage(message, 100 * done / total);
      },
    });
    let name = $('mergedName').value.trim().replace(/[\\/]/g, '_') || 'combined.pdf';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    const blob = new Blob([result.bytes], { type: 'application/pdf' });
    if (state.merged) URL.revokeObjectURL(state.merged.url);
    state.merged = { blob, name, pages: result.pages, files: files.length, url: URL.createObjectURL(blob) };
    $('mergeResultName').textContent = name;
    $('mergeResultSummary').textContent = `${result.pages} pages combined from ${files.length} PDFs. Ready to use.`;
    $('mergeSignatureNote').classList.toggle('hidden', !result.hasSignatures);
    $('previewMergedLink').href = state.merged.url;
    $('mergeResult').classList.remove('hidden');
    renderResults();
    download(blob, name);
    const message = `Saved ${result.pages} pages from ${files.length} PDFs as ${name}.`;
    $('mergeStatus').textContent = message;
    setStage(message, 100);
    toast('Combined PDF downloaded');
  } catch (error) {
    const message = state.cancel || error.name === 'AbortError'
      ? 'Merge cancelled. No PDF downloaded.' : error.message;
    $('mergeStatus').textContent = message;
    setStage(message);
  } finally {
    state.running = false;
    state.mergeAbort = null;
    $('cancelBtn').disabled = true;
    renderQueue();
  }
}

/* --------------------------------------------------------------- rendering */

function renderQueue() {
  const list = $('queue');
  list.innerHTML = '';
  for (const [index, entry] of state.files.entries()) {
    const li = document.createElement('li');
    const label = { idle: 'queued', busy: 'working', done: 'done', err: 'failed' }[entry.status];
    const cls = { idle: '', busy: 'busy', done: 'done', err: 'err' }[entry.status];
    for (const [className, text] of [['name', `${index + 1}. ${entry.file.name}`],
                                    ['size', bytes(entry.file.size)], [`state ${cls}`, label]]) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      if (className === 'name') span.title = entry.file.name;
      li.appendChild(span);
    }
    for (const [delta, text] of [[-1, '↑'], [1, '↓']]) {
      const move = document.createElement('button');
      move.className = 'x';
      move.textContent = text;
      move.title = `Move ${entry.file.name} ${delta < 0 ? 'up' : 'down'}`;
      move.setAttribute('aria-label', move.title);
      const other = index + delta;
      move.disabled = state.running || other < 0 || other >= state.files.length;
      move.onclick = () => {
        [state.files[index], state.files[other]] = [state.files[other], state.files[index]];
        renderQueue();
      };
      li.appendChild(move);
    }
    const remove = document.createElement('button');
    remove.className = 'x';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${entry.file.name}`);
    remove.disabled = state.running;
    remove.onclick = () => {
      state.files = state.files.filter((f) => f.id !== entry.id);
      renderQueue();
    };
    li.appendChild(remove);
    list.appendChild(li);
  }
  $('runBtn').disabled = state.running || !state.files.length;
  $('mergeBtn').disabled = state.running || state.files.length < 2;
  $('clearBtn').disabled = state.running || !state.files.length;
  $('mergedName').disabled = state.running;
}

function renderResults() {
  const has = state.docs.length > 0;
  $('empty').classList.toggle('hidden', has || Boolean(state.merged));
  $('result').classList.toggle('hidden', !has);
  if (!has) { $('tabs').innerHTML = ''; return; }

  const tabs = $('tabs');
  tabs.innerHTML = '';

  if (state.docs.length > 1) {
    const all = document.createElement('button');
    all.className = 'sm' + (state.active === ALL ? ' active' : '');
    all.textContent = `All ${state.docs.length} documents`;
    all.title = 'One merged transcript across every PDF';
    all.onclick = () => { state.active = ALL; renderResults(); };
    tabs.appendChild(all);
  }

  state.docs.forEach((doc, index) => {
    const button = document.createElement('button');
    button.className = 'sm' + (index === state.active ? ' active' : '');
    button.textContent = doc.failed ? `⚠ ${doc.name}` : doc.name;
    button.onclick = () => { state.active = index; renderResults(); };
    tabs.appendChild(button);
  });

  const merged = state.active === ALL;
  const docs = merged ? state.docs : [currentDoc()];
  const sum = (fn) => docs.reduce((n, d) => n + fn(d), 0);
  const chars = sum((d) => d.pages.reduce((n, pg) => n + pg.text.length, 0));
  const images = docs.flatMap((d) => d.images.map((img) => ({ ...img, doc: d.name })));

  $('stats').innerHTML = `
    ${merged ? `<span><b>${state.docs.length}</b> <span class="s">documents</span></span>` : ''}
    <span><b>${sum((d) => d.pageCount)}</b> <span class="s">pages</span></span>
    <span><b>${images.length}</b> <span class="s">images</span></span>
    <span><b>${sum((d) => d.ocrPages)}</b> <span class="s">OCR'd pages</span></span>
    <span><b>${chars.toLocaleString()}</b> <span class="s">characters</span></span>`;

  const warnings = docs.flatMap((d) => d.warnings.map((w) => (merged ? `${d.name}: ${w}` : w)));
  $('warnings').innerHTML = warnings.length
    ? `<div class="warn-box">${warnings.map((w) => w.replace(/</g, '&lt;')).join('<br>')}</div>`
    : '';

  const blocks = buildBlocks(docs, merged);
  $('rendered').innerHTML = blocksToHtml(blocks);
  $('transcript').textContent = merged ? combinedTranscript() : transcriptFor(docs[0]);
  applyRenderMode();
  $('imgCount').textContent = images.length ? `(${images.length})` : '';
  renderGallery(images, merged);
  $('log').textContent = state.logLines.join('\n');

  // Say plainly what the download buttons will produce in this view.
  $('mdBtn').textContent  = merged ? 'Download merged .md'  : 'Download .md';
  $('txtBtn').textContent = merged ? 'Download merged .txt' : 'Download .txt';
  $('copyBtn').textContent = merged ? 'Copy merged transcript' : 'Copy transcript';
  $('docxBtn').textContent = merged ? 'Download merged Word (.docx)' : 'Download Word (.docx)';
  $('copyAllBtn').classList.toggle('hidden', merged || state.docs.length < 2);
}

function applyRenderMode() {
  const formatted = state.render === 'formatted';
  $('rendered').classList.toggle('hidden', !formatted);
  $('transcript').classList.toggle('hidden', formatted);
  document.querySelectorAll('#renderToggle button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === state.render));
}

function renderGallery(images, merged) {
  const gallery = $('gallery');
  gallery.innerHTML = '';
  if (!images.length) {
    gallery.innerHTML = `<div class="empty">No embedded images found in ${merged ? 'these PDFs' : 'this PDF'}.</div>`;
    return;
  }

  for (const image of images) {
    const card = document.createElement('div');
    card.className = 'card';

    const pages = [image.page, ...image.alsoOnPages].join(', ');
    const scanTag = image.isPageScan ? ' • full-page scan' : '';
    const source = merged && image.doc ? `<div class="meta" style="color:var(--accent)">${image.doc}</div>` : '';
    card.innerHTML = `
      <div class="thumb"><img src="${image.url}" alt="${image.filename}" loading="lazy"></div>
      ${source}
      <div class="meta">p${pages} • ${image.width}×${image.height} • ${bytes(image.size)}${scanTag}</div>
      ${image.ocrText.trim() ? `<div class="ocr">${image.ocrText.replace(/</g, '&lt;')}</div>` : ''}`;

    const row = document.createElement('div');
    row.className = 'row';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'sm';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => copyImage(image);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'sm';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = () => download(image.blob, image.filename);

    row.append(copyBtn, saveBtn);

    if (image.ocrText.trim()) {
      const textBtn = document.createElement('button');
      textBtn.className = 'sm';
      textBtn.textContent = 'Copy text';
      textBtn.onclick = () => copyText(image.ocrText, 'Image text copied');
      row.appendChild(textBtn);
    }

    card.appendChild(row);
    gallery.appendChild(card);
  }
}

/* ---------------------------------------------------------------- clipboard */

async function copyText(text, message = 'Copied to clipboard') {
  if (!text.trim()) { toast('Nothing to copy'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    toast(ok ? message : 'Copy failed — select the text and copy manually');
  }
}

async function copyImage(image) {
  try {
    // Clipboard image support is PNG-only across browsers; our blobs already are.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })]);
    toast('Image copied to clipboard');
  } catch (err) {
    toast('Image copy needs Chrome/Edge/Safari over http://localhost — use Save instead');
    log(`image copy failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ export */

async function downloadZip() {
  if (!state.docs.length) return;
  toast('Building ZIP…');
  const JSZip = await loadLibrary('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', 'JSZip');
  const zip = new JSZip();

  for (const doc of state.docs) {
    const folder = zip.folder(safeStem(doc.name));
    folder.file('transcript.md', transcriptFor(doc));
    folder.file('text.txt', plainTextFor(doc));
    folder.file('transcript.docx', await buildDocx(buildBlocks([doc], false)));
    if (doc.images.length) {
      const images = folder.folder('images');
      for (const image of doc.images) images.file(image.filename, image.blob);
    }
    if (doc.pageRenders.length) {
      const pages = folder.folder('pages');
      for (const render of doc.pageRenders) {
        pages.file(`page-${String(render.page).padStart(3, '0')}.png`, render.blob);
      }
    }
  }
  if (state.docs.length > 1) {
    zip.file('combined.md', combinedTranscript());
    zip.file('combined.txt', combinedPlainText());
    zip.file('combined.docx', await buildDocx(buildBlocks(state.docs, true)));
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  download(blob, 'pdfharvest-export.zip');
  toast('ZIP downloaded');
}

/* ------------------------------------------------------------------- wiring */

function addFiles(fileList) {
  if (state.running) { toast('Wait for the current operation to finish, or cancel it.'); return; }
  let added = 0;
  for (const file of fileList) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') continue;
    state.files.push({ id: crypto.randomUUID(), file, status: 'idle' });
    added++;
  }
  if (added) { renderQueue(); toast(`Added ${added} PDF${added > 1 ? 's' : ''}`); }
  else toast('No PDFs in that selection');
}

function init() {
  const drop = $('drop');
  const picker = $('picker');

  drop.onclick = () => picker.click();
  picker.onchange = () => { addFiles(picker.files); picker.value = ''; };

  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('hot'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  // Allow dropping anywhere on the page without the browser navigating away.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!drop.contains(e.target)) addFiles(e.dataTransfer.files);
  });

  $('clearBtn').onclick = () => { state.files = []; renderQueue(); };
  $('runBtn').onclick = run;
  $('mergeBtn').onclick = mergeQueue;
  $('downloadMergedBtn').onclick = () => {
    if (state.merged) download(state.merged.blob, state.merged.name);
  };
  $('cancelBtn').onclick = () => {
    state.cancel = true;
    state.mergeAbort?.abort();
    setStage('Cancelling…');
  };

  $('dpi').oninput = (e) => { $('dpiOut').textContent = e.target.value; };

  document.querySelectorAll('.subtabs button').forEach((button) => {
    button.onclick = () => {
      document.querySelectorAll('.subtabs button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      state.view = button.dataset.view;
      for (const view of ['transcript', 'gallery', 'log']) {
        $(`view-${view}`).classList.toggle('hidden', view !== state.view);
      }
    };
  });

  // Every action follows the active tab: a single PDF, or the merged view.
  const activeText = () =>
    state.active === ALL ? combinedTranscript() : transcriptFor(currentDoc());
  const activePlain = () =>
    state.active === ALL ? combinedPlainText() : plainTextFor(currentDoc());
  const activeStem = () =>
    state.active === ALL ? 'combined-transcript' : safeStem(currentDoc().name);

  $('copyBtn').onclick = () =>
    copyText(activeText(), state.active === ALL ? 'Merged transcript copied' : 'Transcript copied');
  $('copyAllBtn').onclick = () => copyText(combinedTranscript(), 'All transcripts copied');
  $('mdBtn').onclick = () =>
    download(new Blob([activeText()], { type: 'text/markdown' }), `${activeStem()}.md`);
  $('txtBtn').onclick = () =>
    download(new Blob([activePlain()], { type: 'text/plain' }), `${activeStem()}.txt`);
  $('zipBtn').onclick = downloadZip;

  document.querySelectorAll('#renderToggle button').forEach((button) => {
    button.onclick = () => { state.render = button.dataset.mode; applyRenderMode(); };
  });

  $('docxBtn').onclick = async () => {
    if (!state.docs.length) return;
    const merged = state.active === ALL;
    const docs = merged ? state.docs : [currentDoc()];
    toast('Building Word document…');
    try {
      const blob = await buildDocx(buildBlocks(docs, merged));
      download(blob, `${activeStem()}.docx`);
      toast('Word document downloaded');
    } catch (err) {
      toast(`Word export failed: ${err.message}`);
      log(`docx export failed: ${err.message}`);
    }
  };

  renderQueue();
  log('ready — add PDFs to merge or extract');
}

init();
