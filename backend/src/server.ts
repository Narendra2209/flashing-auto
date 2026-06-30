import express, { Request, Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import dotenv from 'dotenv';
import {
  renderPdfToPngs,
  extractPdfText,
  renderPdfPagesCropped,
  RenderedPage,
  TextPage
} from './pdfToPng';
import { parseCuttingList, summaryRowForComponent, ParsedCuttingBlock } from './cuttingList';
import {
  catalogStatus,
  deleteSource,
  ingestExcelBuffer,
  matchRoofingSkus,
  searchCatalog
} from './skuCatalog';
import { isMongoConfigured, pingMongo } from './mongo';
dotenv.config({ override: true });

interface LineItem {
  item_number: number;
  colour: string;
  colour_code: string;
  folds: number;
  girth_original: number;
  girth_rounded: number;
  inventory_id: string;
  pieces: number;
  length: number;
  qty: number;
  tapered: boolean;
  notes: string;
}

interface Order {
  customer_name: string;
  po_number: string;
  job_number: string;
  contact: string;
  date_ordered: string;
  date_required: string;
  delivery_type: string;
  location: string;
  description: string;
  colours: string[];
  line_items: LineItem[];
  total_lm: number;
  total_sqm: number;
  production_notes: string[];
}

interface RoofingCut {
  pieces: number;
  length_mm: number;
}

interface RoofingLineItem {
  item_number: number;
  description: string;
  profile: string;
  quantity: number;
  unit: string;
  inventory_id: string;
  cuts: RoofingCut[];
  notes: string;
}

interface RoofingOrder {
  customer_name: string;
  po_number: string;
  job_number: string;
  contact: string;
  date_ordered: string;
  date_required: string;
  delivery_type: string;
  site_address: string;
  description: string;
  colour: string;
  colour_code: string;
  roof_profile: string;
  pitch: number;
  total_area_sqm: number;
  line_items: RoofingLineItem[];
  production_notes: string[];
}

interface MyobSession {
  cookie: string;
  expires_at: number;
}

interface CustomerMatch {
  id: string;
  name: string;
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const EXTRACTION_PROMPT = `You are an order processor for Metfold Sheet Metal in Australia.
Extract ALL flashing order details from the documents provided (Purchase Order + Flashing Drawing).
You are given the rendered page IMAGES of both PDFs, plus their extracted TEXT LAYER where available.

COMPLETENESS — THIS IS THE MOST IMPORTANT RULE:
- A flashing drawing usually contains MANY flashings (commonly 10–30), each drawn as a separate profile with its own item number, girth, folds, length and quantity. Extract EVERY one of them as a line_item — do NOT stop after the first few.
- Go through the drawing systematically, top to bottom / left to right, and emit one line_item per distinct flashing on the page. Cross-check against any itemised list on the Purchase Order.
- Never truncate the list to save space. If there are 20 flashings on the drawing, line_items MUST have 20 entries. The item_number values should be contiguous (1,2,3,…) and match the count of flashings you can see.
- Do not merge two different flashings into one row, and do not invent rows that are not drawn.

RULES:
- Round girth UP to nearest standard: 100,150,200,240,300,350,400,450,500,550,600,650,700,750,800,900,1000,1100,1200
- Max folds: 10
- Colorbond code format: FC[Girth]G[Folds]F-[ColorCode]
- Color codes: NS=Night Sky, SU=Surfmist, BA=Basalt, MO=Monument, BG=Bluegum, CC=Classic Cream, CG=Cottage Green, DO=Deep Ocean, DU=Dune, DW=Dover White, EH=Evening Haze, GU=Gully, IR=Iron Stone, JA=Jasper, MR=Manor Red, PB=Paper Bark, PE=Pale Eucalpt, SG=Shale Grey, SO=Southerly, WB=Wallaby, WG=Woodland Grey, WS=Windspray
- For tapered flashings flag them
- If pickup: set delivery_type to "PICKUP", else "DELIVERY"

Return ONLY valid JSON, no markdown, no explanation:
{
  "customer_name": "",
  "po_number": "",
  "job_number": "",
  "contact": "",
  "date_ordered": "",
  "date_required": "",
  "delivery_type": "PICKUP or DELIVERY",
  "location": "",
  "description": "",
  "colours": [],
  "line_items": [
    {
      "item_number": 1,
      "colour": "",
      "colour_code": "",
      "folds": 0,
      "girth_original": 0,
      "girth_rounded": 0,
      "inventory_id": "",
      "pieces": 1,
      "length": 0.0,
      "qty": 0.0,
      "tapered": false,
      "notes": ""
    }
  ],
  "total_lm": 0.0,
  "total_sqm": 0.0,
  "production_notes": []
}`;

const MAX_FLASHING_PAGES = 20;

// ─── OpenAI PDF extraction ─────────────────────────────────
app.post(
  '/api/extract',
  upload.fields([
    { name: 'po', maxCount: 1 },
    { name: 'drawing', maxCount: 1 }
  ]),
  async (req: Request, res: Response) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not set on server (.env)' });
      }

      const files = req.files as { [field: string]: Express.Multer.File[] };
      const poFile = files?.['po']?.[0];
      const drawFile = files?.['drawing']?.[0];
      if (!poFile || !drawFile) {
        return res.status(400).json({ error: 'Both PO and drawing PDFs are required' });
      }

      // Render both PDFs to page images so the vision model can actually SEE
      // every flashing drawn on the page. Sending the raw PDF (type:'file')
      // makes gpt-4o read it at low fidelity and it stops after a handful of
      // items — the cause of "20 flashings, only 5 extracted". We also pull the
      // text layer so spelling/numbers come through exactly where present.
      const renderDoc = async (file: Express.Multer.File, label: string) => {
        let images: RenderedPage[] = [];
        let textPages: TextPage[] = [];
        try {
          images = await renderPdfToPngs(file.buffer, { scale: 2.0, maxPages: MAX_FLASHING_PAGES });
        } catch (e: any) {
          console.warn(`[Flashing] ${label} render failed:`, e?.message || e);
        }
        try {
          textPages = await extractPdfText(file.buffer, { maxPages: MAX_FLASHING_PAGES });
        } catch (e: any) {
          console.warn(`[Flashing] ${label} text-layer extraction failed:`, e?.message || e);
        }
        return { images, textPages };
      };

      const [po, draw] = await Promise.all([
        renderDoc(poFile, 'PO'),
        renderDoc(drawFile, 'Drawing')
      ]);

      console.log(
        `[Flashing] rendered PO: ${po.images.length} page(s), Drawing: ${draw.images.length} page(s)`
      );

      const docContent = (
        title: string,
        doc: { images: RenderedPage[]; textPages: TextPage[] }
      ): any[] => {
        const text = doc.textPages
          .map((p) => `--- PAGE ${p.pageNumber} ---\n${p.text}`)
          .join('\n\n')
          .trim();
        return [
          { type: 'text', text: `===== ${title} (${doc.images.length} page image(s)) =====` },
          ...doc.images.map((p) => ({
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${p.content.toString('base64')}`,
              detail: 'high' as const
            }
          })),
          ...(text
            ? [{ type: 'text' as const, text: `TEXT LAYER of ${title} (authoritative for numbers/spelling):\n\n${text}` }]
            : [])
        ];
      };

      const content: any[] = [
        ...docContent('PURCHASE ORDER', po),
        ...docContent('FLASHING DRAWING', draw),
        { type: 'text', text: EXTRACTION_PROMPT }
      ];

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          max_tokens: 8000,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content }]
        })
      });

      const data: any = await openaiRes.json();
      if (!openaiRes.ok) {
        return res
          .status(openaiRes.status)
          .json({ error: data.error?.message || 'OpenAI API error', details: data });
      }

      const raw = data.choices?.[0]?.message?.content || '';
      const clean = raw.replace(/```json|```/g, '').trim();

      let order: Order;
      try {
        order = JSON.parse(clean);
      } catch {
        return res.status(500).json({ error: 'Model returned invalid JSON', raw });
      }

      res.json(order);
    } catch (err: any) {
      console.error('Extract error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Roofing PDF extraction ────────────────────────────────
const ROOFING_EXTRACTION_PROMPT = `You are an order processor for Metfold Sheet Metal in Australia.
Extract ALL roofing order details from the page images of a Metfold Roof Report.

ABSOLUTE RULE — NO GUESSING:
You are TRANSCRIBING values from the rendered page images. Do not invent, round, or substitute numbers. If a number is unreadable or absent, return 0 (or "") for that field — never a plausible-looking placeholder. Suspicious patterns to AVOID:
- Round numbers like 50, 150, 200, 7500 unless they LITERALLY appear in that cell
- The same length repeated across different components (e.g. five cuts all "7500")
- A cuts array with fewer entries than the comma-separated pairs printed on the cutting-list page
- Skipping any row of the Summary table — if the row is printed, it MUST appear in line_items
- Missing Ridge, Valley, or Hip from the cutting list — they are almost always on the cutting list page

The pages contain (in order):
- A "Report For" header block — a 2-column table with labels on the left and values on the right. The labels are: Company, ATTN, Ph, Date, Email. There is also a "ROOF REPORT" cell — that's a section heading, NOT a value.
- A "Site Address" block — one or two cells of free text below the Report For block. The value is a street address (read it from THIS image; do not assume any address).
- A "Note" section listing the material spec for each component (Roof Sheets, Roof Battens, Fascia, Gutter, Downpipes, Sisalation, etc.) with their Colour (Monument / Surfmist / etc.)
- A "Summary of lengths, Area and pitch" table — this is the line item source
- Plan / Estimation / Cutting list pages (use only as supporting context)

HEADER FIELD MAPPING (read CAREFULLY from page 1):
CRITICAL — the examples below show only the FORMAT/shape of a value. They are NOT the answer. NEVER copy an example string into your output. Every value MUST be transcribed from the actual image. If a value is not visible in the image, return "".
- customer_name ← the actual text to the RIGHT of "Company:" on this PDF. Read it from the image — do not assume any company name. Never use "ROOF REPORT" — that is a heading, not a customer name. Never use the site address as the customer name.
- contact ← the value RIGHT of "ATTN:" if present; otherwise "". Append "Ph: <phone>" if a phone is given. If both ATTN and Phone are empty, return "".
- date_ordered ← the value RIGHT of "Date:" in the Report For block (the printed format may vary, e.g. dd.mm.yyyy / dd/mm/yyyy / dd-Mon-yyyy). Keep it exactly as printed on THIS PDF.
- date_required ← "" unless the PDF explicitly lists a separate required/due date.
- po_number ← "" unless the PDF explicitly shows a PO number (most roof reports don't).
- job_number ← "" unless the PDF explicitly shows a job number.
- site_address ← the full text from the "Site Address" cell, exactly as printed on THIS PDF. Include the suburb and any "(DWELLING n)" suffix if present.
- delivery_type ← "PICKUP" if the PDF mentions pickup, otherwise "DELIVERY".

RULES:
- Extract EVERY row from the "Summary of lengths, Area and pitch" table as a line item, EXCEPT these two metadata rows: "Colorbond Roof Area" (its value goes to total_area_sqm, NOT line_items) and "Pitch" (its value goes to pitch, NOT line_items). All other rows go into line_items.
- Common line item rows: Roof Battens, Hip, Ridge, Valley, Fascia, Gutter, Barge Capping, Apron Flashing, Hand Rail, Over Straps, Spring Clips, Standard Rafter Brackets, Sisalation, Downpipes, Pops, Barge Moulds Left, Barge Moulds Right, Stop End Left, Stop End Right, External Cast Corners, External Fascia Corners, Internal Cast Corners, Internal Fascia Corners, Roofing Screws, Battens Zips.
- For each row, read the quantity number and unit verbatim from the table cell (units are usually "m", "Sq.m", "EA", or "Rolls"). Keep the description exactly as printed.
- The colour is usually a single colour applied to all metal components. Read the actual colour from the Note section of THIS PDF — do not default to any colour. Map the colour you read to colour_code: NS=Night Sky, SU=Surfmist, BA=Basalt, MO=Monument, BG=Bluegum, CC=Classic Cream, CG=Cottage Green, DO=Deep Ocean, DU=Dune, DW=Dover White, EH=Evening Haze, GU=Gully, IR=Iron Stone, JA=Jasper, MR=Manor Red, PB=Paper Bark, PE=Pale Eucalpt, SG=Shale Grey, SO=Southerly, WB=Wallaby, WG=Woodland Grey, WS=Windspray.
- roof_profile: copy the roof-sheet spec from the Note section (e.g. "Colorbond .42 BMT CB").
- pitch: the numeric pitch from the Summary table (e.g. 22.5).
- total_area_sqm: the "Colorbond Roof Area" quantity in Sq.m.
- Leave inventory_id as "" — SKU lookup is handled separately.

CUTTING LIST (very important):
- One of the page images is titled "Cutting list for Fascia, Gutter, Hip, Ridge, Valley, Battens, Apron, Barge". It contains a block of text, on the right side of the page, with headers and comma-separated pairs.
- The exact text pattern on that page is:
    <Component>, <Profile>,
    <pieces>/<length_mm>,  <pieces>/<length_mm>,  ...
  For example:
    Ridge, Roll Top Ridge,
    1/7800, 1/7550, 1/3550,
  means 3 cuts: { pieces:1, length_mm:7800 }, { pieces:1, length_mm:7550 }, { pieces:1, length_mm:3550 }.
- READ EVERY PAIR ON THE PAGE. The component blocks you should expect to see (and the headers that anchor them):
  • Ridge, Roll Top Ridge
  • Valley, Valley, CB
  • Fascia, Metal Fascia
  • Gutter, Quad Gutter Slotted
  • Gable, Barge Caping (Corry)
  • Apron, Apron Std
  • Batten 1, Roof Batten 40mm X 7.5M, Zincalume
  • Hip, Roll Top Ridge
  If you cannot find a header on the cutting-list page, set its cuts to [] (do NOT invent pairs).
- The number BEFORE "/" is pieces (typically 1–3, but for Battens it is the total count — often a 2-digit number like 53). The number AFTER "/" is length in mm (a 3- or 4-digit number, e.g. 500, 1400, 7800).
- Map cutting-list components → summary rows like this:
  Ridge → Ridge   |   Hip → Hip   |   Valley → Valley
  Fascia → Fascia   |   Gutter → Gutter
  Gable → Barge Capping   |   Apron → Apron Flashing
  Batten 1 → Roof Battens
- Populate "profile" with the second part of the cutting-list header (e.g. "Roll Top Ridge", "Quad Gutter Slotted", "Metal Fascia", "Roof Batten 40mm X 7.5M Zincalume"). For non-cuttable rows (Pops, Downpipes, Brackets, Sisalation, Screws, Zips, Moulds, Stop Ends, Corners, Roof Area, Hand Rail) leave profile = "" and cuts = [].
- Self-check before returning JSON: for each cuttable row, sum(pieces × length_mm)/1000 must be within ~5% of the summary quantity for that same row. If not, you have mis-read at least one cut — re-examine the image. Examples of correct sums for typical Metfold reports: Ridge ~3 cuts sum to ~19m, Hip ~3-6 cuts sum to ~28m, Fascia ~10-16 cuts sum to ~70-80m, Gutter ~8-12 cuts sum to ~60-65m, Battens 1 row sums to ~400m.
- If the "Notes" column for a line is empty, return notes:"". Do not invent notes.

Return ONLY valid JSON, no markdown, no explanation:
{
  "customer_name": "",
  "po_number": "",
  "job_number": "",
  "contact": "",
  "date_ordered": "",
  "date_required": "",
  "delivery_type": "PICKUP or DELIVERY",
  "site_address": "",
  "description": "",
  "colour": "",
  "colour_code": "",
  "roof_profile": "",
  "pitch": 0,
  "total_area_sqm": 0,
  "line_items": [
    {
      "item_number": 1,
      "description": "",
      "profile": "",
      "quantity": 0,
      "unit": "",
      "inventory_id": "",
      "cuts": [ { "pieces": 0, "length_mm": 0 } ],
      "notes": ""
    }
  ],
  "production_notes": []
}`;

const MAX_ROOFING_PAGES = 20;

// Get the authoritative cutting-list blocks for a roof report.
//  1. Try the PDF text layer (free, exact) — works when the cut list is real text.
//  2. Otherwise the cut list is rasterized into the page image. A full page sent
//     to the vision model gets shrunk to ~768px and the small cut text becomes
//     unreadable (the model then hallucinates/repeats values). So we render a
//     high-res CROP of the cut-list block and have gpt-4o transcribe it verbatim,
//     then parse those exact "pieces/length" pairs.
async function getCutListBlocks(
  buffer: Buffer,
  allTextPages: Array<{ pageNumber: number; text: string }>,
  apiKey: string,
  model: string
): Promise<ParsedCuttingBlock[]> {
  const fromText = parseCuttingList(allTextPages.map((p) => p.text).join('\n'));
  if (fromText.length) {
    console.log(`[Roofing] cut list read from text layer: ${fromText.length} block(s)`);
    return fromText;
  }

  // Pages whose text mentions the cutting list (the heading is usually still
  // real text even when the pairs are rasterized).
  const cutPages = allTextPages
    .filter((p) => /cutting\s+list/i.test(p.text))
    .map((p) => p.pageNumber);
  if (!cutPages.length) {
    console.log('[Roofing] no cutting-list page found to crop');
    return [];
  }

  // The cut-list text block sits on the right side of the page. Crop the right
  // ~45% at high resolution so the text is legible after the model downsizes it.
  const crops = await renderPdfPagesCropped(buffer, cutPages, {
    scale: 4.0,
    region: { left: 0.55, top: 0, width: 0.45, height: 1 }
  });
  if (!crops.length) return [];

  const content: any[] = [
    {
      type: 'text',
      text:
        'Each image is a high-resolution close-up of a cutting-list text block from a roof report. ' +
        'Transcribe ALL of them VERBATIM, exactly as printed — every component header line (e.g. "Fascia, Metal Fascia,") and every "<pieces>/<length>" pair (e.g. "2/9000, 1/7000,"). ' +
        'Preserve line breaks. Do NOT correct, round, or invent any number. Output only the raw transcription.'
    },
    ...crops.map((c) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${c.content.toString('base64')}`, detail: 'high' as const }
    }))
  ];

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 2000, temperature: 0, messages: [{ role: 'user', content }] })
  });
  const data: any = await r.json();
  if (!r.ok) {
    console.warn('[Roofing] cut-list transcription failed:', data?.error?.message || r.status);
    return [];
  }
  const transcription = (data.choices?.[0]?.message?.content || '').replace(/```[a-z]*|```/g, '');
  const blocks = parseCuttingList(transcription);
  console.log(
    `[Roofing] cut list transcribed from ${crops.length} crop(s): ${blocks.length} block(s)`
  );
  return blocks;
}

app.post(
  '/api/roofing/extract',
  upload.single('report'),
  async (req: Request, res: Response) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not set on server (.env)' });
      }

      const reportFile = req.file;
      if (!reportFile) {
        return res.status(400).json({ error: 'Roof Report PDF is required' });
      }

      console.log(
        `[Roofing] /api/roofing/extract received file "${reportFile.originalname}" (${reportFile.mimetype}, ${reportFile.size} bytes)`
      );

      // Pull the text layer from ALL pages first (cheap, no API cost). We use it
      // for two things: (a) to LOCATE the cutting-list page by its heading —
      // its position varies between PDFs, so we never assume a fixed page
      // number — and (b) to feed exact characters to the model so it
      // transcribes rather than guesses pixels.
      let allTextPages: Array<{ pageNumber: number; text: string }> = [];
      try {
        allTextPages = await extractPdfText(reportFile.buffer, { maxPages: MAX_ROOFING_PAGES });
      } catch (e: any) {
        console.warn('[Roofing] Text-layer extraction skipped:', e?.message || e);
      }

      // Decide which pages to send to the vision model. DEFAULT IS ALL PAGES:
      // the data we need is spread across the document (header on p1, the
      // Summary table on another page, and the cutting-list diagrams on several
      // more), and the cut measurements are DRAWN AS IMAGES, not text — so the
      // model must see every page to read them. Only restrict pages if the
      // caller explicitly asks (a "pages" form field or ROOFING_EXTRACT_PAGES).
      const pagesParam = String(
        (req.body?.pages as string) || process.env.ROOFING_EXTRACT_PAGES || 'all'
      )
        .trim()
        .toLowerCase();

      const selectedPages: number[] | null =
        pagesParam === 'all' ? null : parsePageSelection(pagesParam);

      console.log(
        `[Roofing] sending pages=${selectedPages ? selectedPages.join(',') : 'all'}`
      );

      // Render the selected pages to PNG images for gpt-4o vision.
      let pages: Array<{ pageNumber: number; content: Buffer }> = [];
      try {
        pages = await renderPdfToPngs(reportFile.buffer, {
          scale: 2.0,
          maxPages: MAX_ROOFING_PAGES,
          ...(selectedPages ? { pages: selectedPages } : {})
        });
      } catch (e: any) {
        console.error('[Roofing] PDF render error:', e);
        return res.status(400).json({
          error: 'Could not render the PDF. Make sure it is a valid PDF file.',
          details: e?.message || String(e),
          stack: e?.stack
        });
      }

      if (!pages.length) {
        return res.status(400).json({ error: 'PDF has no readable pages.' });
      }

      console.log(`[Roofing] PDF rendered: ${pages.length} page(s)`);

      // Text block sent to the model: just the pages we're showing it.
      const sentPageNos = new Set(pages.map((p) => p.pageNumber));
      const textPages = allTextPages.filter((p) => sentPageNos.has(p.pageNumber));
      const pdfText = textPages.map((p) => `--- PAGE ${p.pageNumber} ---\n${p.text}`).join('\n\n');
      const hasTextLayer = pdfText.replace(/\s+/g, '').length > 0;
      console.log(
        `[Roofing] Text layer: ${hasTextLayer ? `${pdfText.length} chars extracted` : 'none (scanned/image PDF)'}`
      );

      const imageContent = pages.map((p) => ({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${p.content.toString('base64')}`,
          detail: 'high' as const
        }
      }));

      const textLayerBlock = hasTextLayer
        ? {
            type: 'text' as const,
            text:
              'EXACT TEXT LAYER extracted directly from the PDF (authoritative for spelling and numbers — prefer this over reading the pixels; use the images only to understand table layout and which value belongs to which label):\n\n' +
              pdfText
          }
        : null;

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          max_tokens: 6000,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Below are ${pages.length} PNG image(s) from a Metfold Roof Report PDF, in this order: ${pages
                    .map((p) => `page ${p.pageNumber}`)
                    .join(', ')}. (Other pages of the PDF were intentionally omitted.) Read them carefully — TRANSCRIBE values, do NOT guess.`
                },
                ...imageContent,
                ...(textLayerBlock ? [textLayerBlock] : []),
                { type: 'text', text: ROOFING_EXTRACTION_PROMPT }
              ]
            }
          ]
        })
      });

      const data: any = await openaiRes.json();
      if (!openaiRes.ok) {
        return res
          .status(openaiRes.status)
          .json({ error: data.error?.message || 'OpenAI API error', details: data });
      }

      const raw = data.choices?.[0]?.message?.content || '';
      const clean = raw.replace(/```json|```/g, '').trim();

      let order: RoofingOrder;
      try {
        order = JSON.parse(clean);
      } catch {
        return res.status(500).json({ error: 'Model returned invalid JSON', raw });
      }

      // Drop rows the user explicitly doesn't want as line items
      // (Roof Area is metadata → total_area_sqm; Pitch is metadata → pitch).
      const isMetadataRow = (desc: string) => {
        const d = String(desc || '').toLowerCase();
        return (
          d.includes('roof area') ||
          d.includes('roof sheet area') ||
          /^\s*pitch\s*$/.test(d)
        );
      };

      // If the model emitted Roof Area as a line item, lift its quantity
      // into total_area_sqm (in case it forgot to set the metadata field).
      const roofAreaRow = (order.line_items || []).find((it) => isMetadataRow(it.description));
      if (roofAreaRow && (!order.total_area_sqm || order.total_area_sqm === 0)) {
        order.total_area_sqm = Number(roofAreaRow.quantity) || 0;
      }

      // Re-number items so the UI always shows a contiguous list, and
      // normalize cuts so the frontend never has to handle undefined.
      order.line_items = (order.line_items || [])
        .filter((it) => !isMetadataRow(it.description))
        .map((it, i) => ({
          ...it,
          item_number: i + 1,
          profile: it.profile || '',
          cuts: Array.isArray(it.cuts)
            ? it.cuts
                .map((c) => ({
                  pieces: Number(c?.pieces) || 0,
                  length_mm: Number(c?.length_mm) || 0
                }))
                .filter((c) => c.pieces > 0 && c.length_mm > 0)
            : []
        }));

      // Authoritative cuts + profile from the cutting list. Read it from the
      // PDF text layer when possible, otherwise transcribe a high-res crop of
      // the cut-list block with gpt-4o (see getCutListBlocks). These pairs and
      // the header profile (e.g. "Quad Gutter Slotted") are exact, so we
      // OVERWRITE the model's guessed cuts/profile and give the SKU lookup the
      // correct profile to match. Matched to each line item by mapping the
      // cutting-list component → summary-row label.
      try {
        const blocks = await getCutListBlocks(
          reportFile.buffer,
          allTextPages,
          apiKey,
          process.env.OPENAI_MODEL || 'gpt-4o'
        );
        if (blocks.length) {
          const byRow = new Map<string, typeof blocks[number]>();
          for (const b of blocks) byRow.set(summaryRowForComponent(b.component).toLowerCase(), b);

          let overwritten = 0;
          order.line_items = order.line_items.map((it) => {
            // Match the line item to a parsed block by its summary-row label.
            const key = summaryRowForComponent(it.description).toLowerCase();
            const block = byRow.get(key);
            if (!block) return it;
            overwritten++;
            return {
              ...it,
              // Cutting-list profile is authoritative for SKU matching.
              profile: block.profile || it.profile,
              cuts: block.cuts.map((c) => ({ pieces: c.pieces, length_mm: c.length_mm }))
            };
          });
          console.log(
            `[Roofing] cut list applied: ${blocks.length} block(s), ${overwritten} line(s) corrected`
          );
        }
      } catch (e: any) {
        console.warn('[Roofing] cut-list extraction skipped:', e?.message || e);
      }

      // Auto-fill the MYOB Inventory ID for each line by matching its
      // profile/description + the order colour against the uploaded SKU
      // catalog. Best-effort: if Mongo is down or matching throws, the order
      // still comes back (just with blank SKUs to fill in manually).
      if (isMongoConfigured()) {
        try {
          const matches = await matchRoofingSkus(
            order.line_items.map((it) => ({
              description: it.description,
              profile: it.profile
            })),
            order.colour,
            order.roof_profile
          );
          order.line_items = order.line_items.map((it, i) => ({
            ...it,
            inventory_id:
              String(it.inventory_id || '').trim() ||
              (matches[i]?.confident ? matches[i].sku : '')
          }));
          const filled = matches.filter((m) => m.confident).length;
          console.log(
            `[Roofing] SKU auto-match: ${filled}/${order.line_items.length} line(s) filled from catalog`
          );
        } catch (e: any) {
          console.warn('[Roofing] SKU auto-match skipped:', e?.message || e);
        }
      }

      res.json(order);
    } catch (err: any) {
      console.error('Roofing extract error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Local PDF text extraction (no API key) ───────────────
// Pulls the raw text layer out of a PDF using pdfjs-dist locally. No OpenAI
// key required. Returns plain text per page — useful as an offline fallback
// or for debugging what the document actually contains. Does NOT produce the
// structured Order/RoofingOrder JSON (that still needs the LLM endpoints).
app.post(
  '/api/extract-text',
  upload.single('file'),
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'A PDF file is required (field name "file").' });
      }

      let pages: Array<{ pageNumber: number; text: string }> = [];
      try {
        pages = await extractPdfText(file.buffer, { maxPages: MAX_ROOFING_PAGES });
      } catch (e: any) {
        console.error('[ExtractText] PDF parse error:', e);
        return res.status(400).json({
          error: 'Could not read the PDF. Make sure it is a valid PDF file.',
          details: e?.message || String(e)
        });
      }

      const fullText = pages.map((p) => p.text).join('\n\n');
      const hasText = fullText.replace(/\s+/g, '').length > 0;

      res.json({
        pageCount: pages.length,
        hasText,
        pages,
        text: fullText,
        ...(hasText
          ? {}
          : {
              note: 'No text layer found — this is likely a scanned/image-only PDF. Use the LLM extraction endpoint (needs OPENAI_API_KEY) for those.'
            })
      });
    } catch (err: any) {
      console.error('Extract-text error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── MYOB Advanced (Acumatica) integration ────────────────
const MYOB_HOST = process.env.MYOB_HOST || '';
const MYOB_API = MYOB_HOST + (process.env.MYOB_API_PATH || '');

let myobSession: MyobSession | null = null;
// Cache across requests so we don't re-hit the "unknown column" error every time.
// Resets to true on server restart (which is also when .env is re-read).
let lineCustomFieldsSupported: boolean = true;

function extractCookies(response: Response | any): string {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.raw?.()['set-cookie'] || [];
  return (raw as string[]).map((c: string) => c.split(';')[0]).join('; ');
}

async function myobLogin(): Promise<string> {
  if (!MYOB_HOST || !process.env.MYOB_USERNAME || !process.env.MYOB_PASSWORD) {
    throw new Error('MYOB credentials not configured in .env (MYOB_HOST, MYOB_USERNAME, MYOB_PASSWORD)');
  }
  const r = await fetch(`${MYOB_HOST}/entity/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: process.env.MYOB_USERNAME,
      password: process.env.MYOB_PASSWORD,
      company: process.env.MYOB_COMPANY_NAME || '',
      branch: process.env.MYOB_BRANCH || ''
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`MYOB login failed (${r.status}): ${t}`);
  }
  const cookie = extractCookies(r);
  myobSession = { cookie, expires_at: Date.now() + 20 * 60 * 1000 };
  return cookie;
}

async function ensureSession(): Promise<string> {
  if (myobSession && Date.now() < myobSession.expires_at) return myobSession.cookie;
  return await myobLogin();
}

async function myobFetch(
  pathOrUrl: string,
  options: RequestInit = {},
  retryOnAuth = true
): Promise<globalThis.Response> {
  const cookie = await ensureSession();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : MYOB_API + pathOrUrl;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      Cookie: cookie
    } as any
  });
  if (res.status === 401 && retryOnAuth) {
    myobSession = null;
    return myobFetch(pathOrUrl, options, false);
  }
  return res;
}

app.get('/api/myob/status', (_req, res) => {
  res.json({
    configured: !!(MYOB_HOST && process.env.MYOB_USERNAME),
    host: MYOB_HOST || null,
    connected: !!myobSession
  });
});

// Find an existing MYOB Contact by display name (scoped to the customer where possible),
// or create a new one linked to the customer. Returns the ContactID to put on the SO.
async function ensureContact(customerId: string, contactStr: string): Promise<number | null> {
  if (!contactStr) return null;
  const { name, phone } = parseContact(contactStr);
  if (!name) return null;

  // 1. Lookup by DisplayName
  try {
    const safe = name.replace(/'/g, "''");
    const r = await myobFetch(
      `/Contact?$filter=DisplayName eq '${encodeURIComponent(safe)}'&$top=5`
    );
    if (r.ok) {
      const arr = (await r.json()) as any[];
      const preferred =
        arr.find((c) => c.BusinessAccount?.value === customerId) || arr[0];
      if (preferred?.ContactID?.value) {
        console.log(`[MYOB] Contact "${name}" found → ContactID ${preferred.ContactID.value}`);
        return preferred.ContactID.value;
      }
    }
  } catch (e: any) {
    console.warn('[MYOB] Contact lookup error:', e.message);
  }

  // 2. Create new Contact linked to the customer
  try {
    const parts = name.split(/\s+/);
    const firstName = parts[0] || name;
    const lastName = parts.slice(1).join(' ') || '';

    const body: any = {
      DisplayName: { value: name },
      FirstName: { value: firstName },
      LastName: { value: lastName },
      BusinessAccount: { value: customerId }
    };
    if (phone) body.Phone1 = { value: phone };

    const r = await myobFetch('/Contact', {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (r.ok) {
      const data: any = await r.json();
      const id = data.ContactID?.value;
      console.log(`[MYOB] Created contact "${name}" → ContactID ${id}`);
      return id || null;
    }
    console.warn(`[MYOB] Contact create failed (${r.status}):`, await r.text());
  } catch (e: any) {
    console.warn('[MYOB] Contact create error:', e.message);
  }
  return null;
}

async function searchCustomers(nameRaw: string, limit = 8): Promise<CustomerMatch[]> {
  if (!nameRaw) return [];
  const tokens = String(nameRaw)
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const safe = String(nameRaw).replace(/'/g, "''");
  const queries = [
    `/Customer?$filter=CustomerID eq '${encodeURIComponent(safe)}'&$select=CustomerID,CustomerName&$top=${limit}`,
    `/Customer?$filter=CustomerName eq '${encodeURIComponent(safe)}'&$select=CustomerID,CustomerName&$top=${limit}`,
    `/Customer?$filter=substringof('${encodeURIComponent(safe)}',CustomerName)&$select=CustomerID,CustomerName&$top=${limit}`,
    ...tokens.map(
      (t) =>
        `/Customer?$filter=substringof('${encodeURIComponent(t.replace(/'/g, "''"))}',CustomerName)&$select=CustomerID,CustomerName&$top=${limit}`
    ),
    ...tokens.map(
      (t) =>
        `/Customer?$filter=startswith(CustomerName,'${encodeURIComponent(t.replace(/'/g, "''"))}')&$select=CustomerID,CustomerName&$top=${limit}`
    )
  ];
  const seen = new Set<string>();
  const results: CustomerMatch[] = [];
  for (const q of queries) {
    try {
      const r = await myobFetch(q);
      if (!r.ok) continue;
      const arr: any = await r.json();
      for (const c of arr || []) {
        const id = c.CustomerID?.value;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        results.push({ id, name: c.CustomerName?.value || '' });
        if (results.length >= limit) return results;
      }
    } catch {
      /* ignore and try next strategy */
    }
  }
  return results;
}

async function lookupCustomerId(nameRaw: string): Promise<CustomerMatch | null> {
  const results = await searchCustomers(nameRaw, 1);
  return results[0] || null;
}

app.get('/api/myob/customer-search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ candidates: [] });
    const candidates = await searchCustomers(q, 8);
    res.json({ candidates });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Submit Sales Order to MYOB Advanced ──────────────────
app.post('/api/submit-myob', async (req, res) => {
  try {
    const { order, customerIdOverride } = req.body as {
      order: Order;
      customerIdOverride?: string;
    };
    if (!order) return res.status(400).json({ error: 'Order payload required' });

    let customerId = (customerIdOverride || '').trim();
    let customerResolvedFrom: string = 'override';
    if (!customerId) {
      const match = await lookupCustomerId(order.customer_name);
      if (match) {
        customerId = match.id;
        customerResolvedFrom = `lookup (matched "${match.name}")`;
      }
    }
    if (!customerId && process.env.MYOB_DEFAULT_CUSTOMER_ID) {
      customerId = process.env.MYOB_DEFAULT_CUSTOMER_ID;
      customerResolvedFrom = 'env default';
    }
    if (!customerId) {
      return res.status(400).json({
        error: `Customer "${order.customer_name}" not found in MYOB. Pick one on the review screen, or set MYOB_DEFAULT_CUSTOMER_ID in .env.`
      });
    }

    const piecesField = process.env.MYOB_LINE_PIECES_FIELD || 'UsrACSNoOfPeices';
    const lengthField = process.env.MYOB_LINE_LENGTH_FIELD || 'UsrACSLength';
    const lineCustomView = process.env.MYOB_LINE_CUSTOM_VIEW || 'Transactions';

    // Send Pieces and Length as top-level line fields (same shape as OrderQty).
    // If MYOB says those fields don't exist, we remember that and skip them
    // on subsequent requests this session.
    const usePiecesLength = lineCustomFieldsSupported;

    const details = (order.line_items || []).map((item) => {
      const pieces = Number(item.pieces) || 0;
      const length = Number(item.length) || 0;
      const qty = Number(item.qty) || pieces * length;

      const profile = `${item.colour || ''} ${item.girth_rounded || ''}G ${item.folds || ''}F FLASHING${
        item.tapered ? ' (TAPERED)' : ''
      }`.trim();
      const breakdown = `${pieces} pc × ${length.toFixed(3)}m = ${qty.toFixed(3)}m`;

      const line: any = {
        InventoryID: { value: item.inventory_id || '' },
        OrderQty: { value: qty },
        UnitPrice: { value: 0 },
        TransactionDescription: { value: `${profile} | ${breakdown}` }
      };
      if (usePiecesLength) {
        line.custom = {
          [lineCustomView]: {
            [piecesField]: { type: 'CustomDecimalField', value: pieces },
            [lengthField]: { type: 'CustomDecimalField', value: length }
          }
        };
      }
      return line;
    });

    const requestedOn = parseDate(order.date_required) || parseDate(order.date_ordered);
    const contact = (order.contact || '').trim();

    const payload: any = {
      OrderType: { value: 'SO' },
      CustomerID: { value: customerId },
      CustomerOrder: { value: order.po_number || '' },
      Description: { value: (order.description || '').substring(0, 255) },
      Hold: { value: true },
      Details: details
    };

    if (requestedOn) payload.RequestedOn = { value: requestedOn };

    // Contact: look up existing MYOB Contact, or create a new one linked to this customer.
    let contactId: number | null = null;
    if (contact) {
      contactId = await ensureContact(customerId, contact);
      if (contactId) {
        payload.ContactID = { value: contactId };
      } else {
        // Fallback: override pattern if we couldn't get/create a ContactID
        const { name, phone } = parseContact(contact);
        payload.Contact = {
          OverrideContact: { value: true },
          Attention: { value: name || contact },
          ...(phone ? { Phone1: { value: phone } } : {})
        };
      }
    }

    console.log(`[MYOB] CustomerID resolved via ${customerResolvedFrom} → ${customerId}`);
    if (requestedOn) console.log(`[MYOB] RequestedOn → ${requestedOn}`);
    if (contact) console.log(`[MYOB] Contact → ${contact}${contactId ? ` (ContactID ${contactId})` : ' (fallback override)'}`);

    const basePoNumber = order.po_number || '';
    const MAX_RETRIES = 20;
    let attempt = 0;
    let soRes!: globalThis.Response;
    let bodyText = '';
    let usedPo = basePoNumber;

    while (attempt <= MAX_RETRIES) {
      payload.CustomerOrder = { value: usedPo };

      soRes = await myobFetch('/SalesOrder', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      bodyText = await soRes.text();

      if (soRes.ok) break;

      // If MYOB doesn't recognise our custom column names, remember that for
      // the rest of this server session and fail cleanly — do NOT retry within
      // this request, otherwise Acumatica's partial-commit behaviour creates
      // a duplicate SO on the next attempt.
      if (isUnknownColumnError(bodyText)) {
        lineCustomFieldsSupported = false;
        return res.status(400).json({
          error: `MYOB doesn't have custom column "${piecesField}" or "${lengthField}" under view "${lineCustomView}". Open /api/myob/so-debug?nbr=<an-existing-SO> to see the real field names, set them in .env, and restart the backend. Future submissions (without restart) will skip custom fields automatically — click Submit once more.`,
          details: tryParseJson(bodyText)
        });
      }

      if (!isDuplicatePoError(bodyText)) break;

      attempt++;
      usedPo = `${basePoNumber}-${attempt + 1}`;
      console.log(`[MYOB] PO "${payload.CustomerOrder.value}" already used; retrying as "${usedPo}"`);
    }

    if (!soRes.ok) {
      return res.status(soRes.status).json({
        error: 'MYOB rejected the order',
        status: soRes.status,
        customerId,
        customerResolvedFrom,
        attempts: attempt + 1,
        details: tryParseJson(bodyText)
      });
    }

    const result: any = tryParseJson(bodyText) || {};
    res.json({
      Number: result.OrderNbr?.value || 'created',
      Type: result.OrderType?.value,
      Status: result.Status?.value,
      Hold: result.Hold?.value,
      CustomerID: result.CustomerID?.value,
      CustomerOrder: usedPo,
      poSuffixed: usedPo !== basePoNumber,
      piecesLengthSent: usePiecesLength,
      contactId,
      raw: result
    });
  } catch (err: any) {
    console.error('MYOB submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Submit Roofing Sales Order to MYOB Advanced ──────────
app.post('/api/roofing/submit-myob', async (req, res) => {
  try {
    const { order, customerIdOverride } = req.body as {
      order: RoofingOrder;
      customerIdOverride?: string;
    };
    if (!order) return res.status(400).json({ error: 'Order payload required' });

    let customerId = (customerIdOverride || '').trim();
    let customerResolvedFrom: string = 'override';
    if (!customerId) {
      const match = await lookupCustomerId(order.customer_name);
      if (match) {
        customerId = match.id;
        customerResolvedFrom = `lookup (matched "${match.name}")`;
      }
    }
    if (!customerId && process.env.MYOB_DEFAULT_CUSTOMER_ID) {
      customerId = process.env.MYOB_DEFAULT_CUSTOMER_ID;
      customerResolvedFrom = 'env default';
    }
    if (!customerId) {
      return res.status(400).json({
        error: `Customer "${order.customer_name}" not found in MYOB. Pick one on the review screen, or set MYOB_DEFAULT_CUSTOMER_ID in .env.`
      });
    }

    const missingSkus = (order.line_items || []).filter(
      (it) => !String(it.inventory_id || '').trim()
    );
    if (missingSkus.length) {
      return res.status(400).json({
        error: `Some roofing lines have no MYOB Inventory ID: ${missingSkus
          .map((m) => m.description)
          .join(', ')}. Fill them on the review screen before submitting.`
      });
    }

    const details = (order.line_items || []).map((item) => {
      const qty = Number(item.quantity) || 0;
      const cutSummary =
        Array.isArray(item.cuts) && item.cuts.length
          ? ' | cuts: ' + item.cuts.map((c) => `${c.pieces}/${c.length_mm}`).join(', ')
          : '';
      const profile = item.profile ? ` (${item.profile})` : '';
      const desc =
        `${item.description}${profile}${item.unit ? ` [${item.unit}]` : ''}${cutSummary}${
          item.notes ? ` — ${item.notes}` : ''
        }`.substring(0, 255);
      return {
        InventoryID: { value: String(item.inventory_id || '').trim() },
        OrderQty: { value: qty },
        UnitPrice: { value: 0 },
        TransactionDescription: { value: desc }
      };
    });

    const requestedOn = parseDate(order.date_required) || parseDate(order.date_ordered);
    const contact = (order.contact || '').trim();

    const headerParts = [
      order.roof_profile,
      order.colour,
      order.pitch ? `Pitch ${order.pitch}` : '',
      order.site_address
    ].filter(Boolean);
    const description = (order.description || headerParts.join(' · ')).substring(0, 255);

    const payload: any = {
      OrderType: { value: 'SO' },
      CustomerID: { value: customerId },
      CustomerOrder: { value: order.po_number || '' },
      Description: { value: description },
      Hold: { value: true },
      Details: details
    };

    if (requestedOn) payload.RequestedOn = { value: requestedOn };

    let contactId: number | null = null;
    if (contact) {
      contactId = await ensureContact(customerId, contact);
      if (contactId) {
        payload.ContactID = { value: contactId };
      } else {
        const { name, phone } = parseContact(contact);
        payload.Contact = {
          OverrideContact: { value: true },
          Attention: { value: name || contact },
          ...(phone ? { Phone1: { value: phone } } : {})
        };
      }
    }

    console.log(`[MYOB-Roofing] CustomerID resolved via ${customerResolvedFrom} → ${customerId}`);
    if (requestedOn) console.log(`[MYOB-Roofing] RequestedOn → ${requestedOn}`);
    if (contact) console.log(`[MYOB-Roofing] Contact → ${contact}${contactId ? ` (ContactID ${contactId})` : ' (fallback override)'}`);

    const basePoNumber = order.po_number || '';
    const MAX_RETRIES = 20;
    let attempt = 0;
    let soRes!: globalThis.Response;
    let bodyText = '';
    let usedPo = basePoNumber;

    while (attempt <= MAX_RETRIES) {
      payload.CustomerOrder = { value: usedPo };

      soRes = await myobFetch('/SalesOrder', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      bodyText = await soRes.text();

      if (soRes.ok) break;
      if (!isDuplicatePoError(bodyText)) break;

      attempt++;
      usedPo = `${basePoNumber}-${attempt + 1}`;
      console.log(`[MYOB-Roofing] PO "${payload.CustomerOrder.value}" already used; retrying as "${usedPo}"`);
    }

    if (!soRes.ok) {
      return res.status(soRes.status).json({
        error: 'MYOB rejected the roofing order',
        status: soRes.status,
        customerId,
        customerResolvedFrom,
        attempts: attempt + 1,
        details: tryParseJson(bodyText)
      });
    }

    const result: any = tryParseJson(bodyText) || {};
    res.json({
      Number: result.OrderNbr?.value || 'created',
      Type: result.OrderType?.value,
      Status: result.Status?.value,
      Hold: result.Hold?.value,
      CustomerID: result.CustomerID?.value,
      CustomerOrder: usedPo,
      poSuffixed: usedPo !== basePoNumber,
      contactId,
      raw: result
    });
  } catch (err: any) {
    console.error('MYOB roofing submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: GET /api/myob/so-debug?nbr=SO026068
// Dumps everything about an existing SO so you can find the real field names
// for Contact / Pieces / Length. Look for fields whose values match what you
// see in the MYOB UI for that SO (e.g. the real pieces number / length).
app.get('/api/myob/so-debug', async (req, res) => {
  try {
    const nbr = (req.query.nbr || '').toString().trim();
    if (!nbr) return res.status(400).json({ error: 'pass ?nbr=<SO number>' });
    const r = await myobFetch(
      `/SalesOrder/SO/${encodeURIComponent(nbr)}?$expand=Details,Details/custom,Contact,BillToContact,ShipToContact,custom`
    );
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text });
    const data: any = tryParseJson(text);
    const firstLine = data?.Details?.[0] || {};

    const contactBlocks: any = {};
    for (const k of Object.keys(data || {})) {
      if (/contact/i.test(k)) contactBlocks[k] = data[k];
    }

    res.json({
      OrderNbr: data?.OrderNbr?.value,
      Description: data?.Description?.value,

      headerContactRelatedFields: contactBlocks,

      headerCustom: data?.custom || {},
      headerCustomFieldNames: Object.keys(data?.custom || {}).reduce(
        (acc: any, view: string) => {
          acc[view] = Object.keys(data.custom[view] || {});
          return acc;
        },
        {}
      ),

      firstLineAllKeys: Object.keys(firstLine || {}),
      firstLineStandard: Object.fromEntries(
        Object.entries(firstLine || {}).filter(([k]) => k !== 'custom')
      ),
      firstLineCustom: firstLine?.custom || {},
      firstLineCustomFieldNames: Object.keys(firstLine?.custom || {}).reduce(
        (acc: any, view: string) => {
          acc[view] = Object.keys(firstLine.custom[view] || {});
          return acc;
        },
        {}
      ),

      fullResponse: data
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Asks MYOB what fields are exposed on the SalesOrder endpoint.
// If "Pieces"/"Length" aren't listed here, they're NOT published to the REST
// API (even though they show in the UI) — the MYOB admin must add them to
// the Web Service Endpoint in MYOB Advanced → Customization → Web Service Endpoints.
app.get('/api/myob/schema', async (_req, res) => {
  try {
    const r = await myobFetch('/SalesOrder/$adHocSchema');
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text });
    const data: any = tryParseJson(text);

    // Try to surface the most useful info — all field names on the detail lines
    const detailSchema = data?.Details || data?.Detail || null;
    const detailFieldNames = detailSchema
      ? Object.keys(detailSchema).filter((k) => typeof detailSchema[k] === 'object')
      : [];

    const headerFieldNames = Object.keys(data || {}).filter(
      (k) => typeof data[k] === 'object' && !Array.isArray(data[k])
    );

    res.json({
      headerFieldNames,
      detailFieldNames,
      hasPieces: detailFieldNames.some((n) => /piece/i.test(n)),
      hasLength: detailFieldNames.some((n) => /length/i.test(n)),
      detailSchema,
      fullSchema: data
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SKU Catalog (MongoDB) ────────────────────────────────
app.get('/api/sku-catalog/status', async (_req, res) => {
  if (!isMongoConfigured()) {
    return res.json({
      configured: false,
      connected: false,
      message:
        'MONGODB_URI not set in backend/.env. Add the Atlas connection string and restart the backend.',
      total: 0,
      files: []
    });
  }
  const ping = await pingMongo();
  if (!ping.ok) {
    return res.json({
      configured: true,
      connected: false,
      message: `MongoDB reachable check failed: ${ping.error}`,
      total: 0,
      files: []
    });
  }
  try {
    const status = await catalogStatus();
    res.json({ configured: true, connected: true, ...status });
  } catch (err: any) {
    res.status(500).json({
      configured: true,
      connected: true,
      error: err.message,
      total: 0,
      files: []
    });
  }
});

app.post(
  '/api/sku-catalog/upload',
  upload.array('files', 50),
  async (req, res) => {
    try {
      if (!isMongoConfigured()) {
        return res.status(400).json({
          error: 'MONGODB_URI not set. Add it to backend/.env and restart.'
        });
      }
      const files = (req.files as Express.Multer.File[]) || [];
      if (!files.length) {
        return res.status(400).json({ error: 'No files uploaded (field name must be "files").' });
      }
      const results: any[] = [];
      const errors: any[] = [];
      for (const f of files) {
        const ext = (f.originalname || '').toLowerCase().split('.').pop() || '';
        if (ext !== 'xlsx' && ext !== 'xls') {
          errors.push({ file: f.originalname, error: 'Not an .xlsx/.xls file — skipped.' });
          continue;
        }
        try {
          const r = await ingestExcelBuffer(f.originalname, f.buffer);
          results.push(r);
          console.log(
            `[SKU] Ingested ${f.originalname}: ${r.total_inserted} row(s) across ${r.sheets.length} sheet(s)`
          );
        } catch (e: any) {
          console.error(`[SKU] Ingest failed for ${f.originalname}:`, e);
          errors.push({ file: f.originalname, error: e?.message || String(e) });
        }
      }
      const status = await catalogStatus();
      res.json({
        uploaded: results,
        errors,
        total_in_catalog: status.total,
        files_in_catalog: status.files.length
      });
    } catch (err: any) {
      console.error('SKU upload error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/api/sku-catalog/search', async (req, res) => {
  try {
    if (!isMongoConfigured()) {
      return res.status(400).json({ error: 'MONGODB_URI not set.' });
    }
    const q = (req.query.q || '').toString();
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const items = await searchCatalog(q, limit);
    res.json({ items, count: items.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Re-run SKU auto-match for a set of roofing lines (used by the review screen
// "Auto-match SKUs" button, e.g. after uploading the catalog post-extraction).
app.post('/api/sku-catalog/match-roofing', async (req, res) => {
  try {
    if (!isMongoConfigured()) {
      return res.status(400).json({ error: 'MONGODB_URI not set.' });
    }
    const { items, colour, roof_profile } = req.body as {
      items: { description: string; profile: string }[];
      colour: string;
      roof_profile?: string;
    };
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items array required' });
    }
    const matches = await matchRoofingSkus(items, colour || '', roof_profile || '');
    res.json({ matches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sku-catalog/source/:name', async (req, res) => {
  try {
    if (!isMongoConfigured()) {
      return res.status(400).json({ error: 'MONGODB_URI not set.' });
    }
    const name = req.params.name;
    if (!name) return res.status(400).json({ error: 'source name required' });
    const deleted = await deleteSource(name);
    res.json({ deleted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ─── helpers ──────────────────────────────────────────────
// Parse a page-selection string into a sorted list of 1-based page numbers.
// "1,3" → [1,3]; "all" / "" → null (meaning "every page"). Ignores junk.
function parsePageSelection(raw: string): number[] | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'all') return null;
  const nums = s
    .split(/[,\s]+/)
    .map((t) => parseInt(t, 10))
    .filter((n) => Number.isInteger(n) && n >= 1);
  return nums.length ? Array.from(new Set(nums)).sort((a, b) => a - b) : null;
}

function tryParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isDuplicatePoError(bodyText: string): boolean {
  const s = String(bodyText || '').toLowerCase();
  return s.includes('same customer order number') || s.includes('customer order nbr');
}

function isUnknownColumnError(bodyText: string): boolean {
  const s = String(bodyText || '').toLowerCase();
  return s.includes('is not found in the data set');
}

function parseDate(s: string): string | null {
  if (!s) return null;
  const dmY = String(s).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmY) return `${dmY[3]}-${dmY[2].padStart(2, '0')}-${dmY[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(s))) return String(s).substring(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().substring(0, 10);
}

function parseContact(s: string): { name: string; phone: string } {
  if (!s) return { name: '', phone: '' };
  const phoneMatch = s.match(/(\+?\d[\d\s\-]{6,})/);
  const phone = phoneMatch ? phoneMatch[1].replace(/\s+/g, '') : '';
  const name = s.replace(/[-|,]/g, ' ').replace(phone, '').trim().replace(/\s+/g, ' ');
  return { name, phone };
}

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Metfold backend running on http://localhost:${PORT}`);
});
