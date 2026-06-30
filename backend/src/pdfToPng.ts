// Custom PDF→PNG renderer that bypasses pdf-to-png-converter's broken
// Windows path handling (it builds cMapUrl with `\` which pdfjs-dist 5.x
// rejects). Uses pdfjs-dist + @napi-rs/canvas directly. Both packages are
// already installed as transitive deps of pdf-to-png-converter.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// @napi-rs/canvas is CJS — safe to require synchronously.
// pdfjs-dist 5.x is ESM only — must use dynamic import().
const nrequire = createRequire(__filename);

// pdfjs needs a few DOM globals in Node. @napi-rs/canvas provides them.
function installPdfjsGlobals() {
  const canvasMod = nrequire('@napi-rs/canvas');
  const g = globalThis as any;
  if (!g.DOMMatrix && canvasMod.DOMMatrix) g.DOMMatrix = canvasMod.DOMMatrix;
  if (!g.ImageData && canvasMod.ImageData) g.ImageData = canvasMod.ImageData;
  if (!g.Path2D && canvasMod.Path2D) g.Path2D = canvasMod.Path2D;
}

let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    installPdfjsGlobals();
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

function fileUrlForDir(absDir: string): string {
  // pdfjs-dist 5.x's URL validator requires the URL to end with "/".
  // pathToFileURL on Windows yields e.g. file:///D:/.../cmaps — we add the slash.
  const withSep = absDir.endsWith(path.sep) ? absDir : absDir + path.sep;
  return pathToFileURL(withSep).href;
}

export interface RenderedPage {
  pageNumber: number;
  content: Buffer;
}

export interface TextPage {
  pageNumber: number;
  text: string;
}

// Decide which 1-based page numbers to process.
// - opts.pages: explicit list (e.g. [1, 3]) — only existing pages are kept,
//   deduped, and returned in ascending order.
// - otherwise: pages 1..min(numPages, maxPages).
function selectPageNumbers(
  numPages: number,
  opts: { pages?: number[]; maxPages?: number }
): number[] {
  if (opts.pages && opts.pages.length) {
    return Array.from(new Set(opts.pages))
      .filter((p) => Number.isInteger(p) && p >= 1 && p <= numPages)
      .sort((a, b) => a - b);
  }
  const last = Math.min(numPages, opts.maxPages ?? 20);
  return Array.from({ length: last }, (_, i) => i + 1);
}

/**
 * Extract raw text from a PDF locally, with no external API key.
 * Uses pdfjs-dist's text-content layer (the same lib used to render pages).
 * Returns plain text per page — it does NOT do any intelligent parsing of
 * line items / girth / colour codes; that still requires an LLM.
 *
 * Note: this only works for PDFs that contain a real text layer. Scanned /
 * image-only PDFs yield empty text — those still need OCR or vision.
 */
export async function extractPdfText(
  pdfBuffer: Buffer,
  opts: { maxPages?: number; pages?: number[] } = {}
): Promise<TextPage[]> {
  const pdfjsLib = await loadPdfjs();

  const pdfjsPkg = nrequire.resolve('pdfjs-dist/package.json');
  const pdfjsRoot = path.dirname(pdfjsPkg);
  const cMapUrl = fileUrlForDir(path.join(pdfjsRoot, 'cmaps'));
  const standardFontDataUrl = fileUrlForDir(path.join(pdfjsRoot, 'standard_fonts'));

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    isEvalSupported: false,
    verbosity: 0
  }).promise;

  try {
    const pageNumbers = selectPageNumbers(doc.numPages, opts);
    const out: TextPage[] = [];
    for (const i of pageNumbers) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        // Reconstruct lines: pdfjs gives each text run an item; items carry a
        // hasEOL flag when a line break follows. Join runs with spaces and
        // break on EOL so the output keeps a roughly page-like layout.
        let text = '';
        for (const item of content.items as any[]) {
          if (typeof item.str !== 'string') continue;
          text += item.str;
          if (item.hasEOL) text += '\n';
          else text += ' ';
        }
        out.push({ pageNumber: i, text: text.replace(/[ \t]+\n/g, '\n').trim() });
      } finally {
        page.cleanup();
      }
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

export async function renderPdfToPngs(
  pdfBuffer: Buffer,
  opts: { scale?: number; maxPages?: number; pages?: number[] } = {}
): Promise<RenderedPage[]> {
  const scale = opts.scale ?? 2.0;

  const pdfjsLib = await loadPdfjs();
  const { createCanvas } = nrequire('@napi-rs/canvas');

  // Resolve pdfjs-dist asset dirs at runtime so it works from anywhere.
  const pdfjsPkg = nrequire.resolve('pdfjs-dist/package.json');
  const pdfjsRoot = path.dirname(pdfjsPkg);
  const cMapUrl = fileUrlForDir(path.join(pdfjsRoot, 'cmaps'));
  const standardFontDataUrl = fileUrlForDir(path.join(pdfjsRoot, 'standard_fonts'));

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    disableFontFace: false,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0
  }).promise;

  try {
    const pageNumbers = selectPageNumbers(doc.numPages, opts);
    const out: RenderedPage[] = [];
    for (const i of pageNumbers) {
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx as any, viewport }).promise;
        out.push({ pageNumber: i, content: canvas.toBuffer('image/png') });
      } finally {
        page.cleanup();
      }
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/** A sub-rectangle of a page, expressed as fractions (0..1) of width/height. */
export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Render specific pages at high resolution and crop each to a sub-region.
 * Used to produce a legible close-up of the cutting-list text block: when a
 * full page is sent to a vision model it gets shrunk to ~768px and the small
 * cut-list text becomes unreadable, so we crop to it first.
 */
export async function renderPdfPagesCropped(
  pdfBuffer: Buffer,
  pageNumbers: number[],
  opts: { scale?: number; region?: CropRegion } = {}
): Promise<RenderedPage[]> {
  const scale = opts.scale ?? 4.0;
  const region = opts.region ?? { left: 0, top: 0, width: 1, height: 1 };

  const pdfjsLib = await loadPdfjs();
  const { createCanvas } = nrequire('@napi-rs/canvas');
  const pdfjsPkg = nrequire.resolve('pdfjs-dist/package.json');
  const pdfjsRoot = path.dirname(pdfjsPkg);
  const cMapUrl = fileUrlForDir(path.join(pdfjsRoot, 'cmaps'));
  const standardFontDataUrl = fileUrlForDir(path.join(pdfjsRoot, 'standard_fonts'));

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    isEvalSupported: false,
    verbosity: 0
  }).promise;

  try {
    const valid = pageNumbers.filter((p) => p >= 1 && p <= doc.numPages);
    const out: RenderedPage[] = [];
    for (const i of valid) {
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale });
        const fullW = Math.ceil(viewport.width);
        const fullH = Math.ceil(viewport.height);
        const cropX = Math.floor(fullW * region.left);
        const cropY = Math.floor(fullH * region.top);
        const cropW = Math.max(1, Math.floor(fullW * region.width));
        const cropH = Math.max(1, Math.floor(fullH * region.height));

        // Render the full page, then translate so the crop sits at (0,0).
        const canvas = createCanvas(cropW, cropH);
        const ctx = canvas.getContext('2d');
        ctx.translate(-cropX, -cropY);
        await page.render({ canvasContext: ctx as any, viewport }).promise;
        out.push({ pageNumber: i, content: canvas.toBuffer('image/png') });
      } finally {
        page.cleanup();
      }
    }
    return out;
  } finally {
    await doc.destroy();
  }
}
