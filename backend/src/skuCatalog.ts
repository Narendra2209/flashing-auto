import * as XLSX from 'xlsx';
import { getSkuCollection } from './mongo';

// All field names in storage are normalized to lowercase snake_case so the
// matcher doesn't need to know which Excel column-name variant produced them.
const HEADER_ALIASES: Record<string, string> = {
  'product name': 'product_name',
  product: 'product_name',
  name: 'product_name',
  sku: 'sku',
  code: 'sku',
  description: 'description',
  desc: 'description',
  uom: 'uom',
  unit: 'uom',
  price: 'price',
  'price ': 'price',
  material: 'material',
  colour: 'colour',
  color: 'colour',
  size: 'size',
  pack: 'pack',
  length: 'length',
  category: 'category'
};

function normalizeHeader(raw: any): string {
  const k = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return HEADER_ALIASES[k] || k.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function normalizeValue(v: any): any {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim();
  return s;
}

export interface ParsedSkuRow {
  product_name: string;
  sku: string;
  colour: string;
  material: string;
  description: string;
  uom: string;
  price: number | string;
  source_file: string;
  source_sheet: string;
  raw: Record<string, any>;
}

export interface UploadResult {
  file: string;
  sheets: { name: string; rows: number; inserted: number }[];
  total_rows: number;
  total_inserted: number;
}

export async function ingestExcelBuffer(
  fileName: string,
  buffer: Buffer
): Promise<UploadResult> {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const col = await getSkuCollection();

  // Replace-by-source-file: remove old rows from this file so re-upload
  // doesn't accumulate stale duplicates.
  await col.deleteMany({ source_file: fileName });

  const result: UploadResult = {
    file: fileName,
    sheets: [],
    total_rows: 0,
    total_inserted: 0
  };

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
    if (!rows.length) {
      result.sheets.push({ name: sheetName, rows: 0, inserted: 0 });
      continue;
    }

    // First non-empty row that has at least 2 non-empty cells is treated as headers.
    let headerRowIdx = rows.findIndex(
      (r) => Array.isArray(r) && r.filter((c) => String(c ?? '').trim()).length >= 2
    );
    if (headerRowIdx < 0) headerRowIdx = 0;
    const rawHeaders: string[] = rows[headerRowIdx].map((h) => String(h ?? ''));
    const headers = rawHeaders.map(normalizeHeader);

    const docs: any[] = [];
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!Array.isArray(r)) continue;
      const isEmpty = r.every((c) => String(c ?? '').trim() === '');
      if (isEmpty) continue;

      const raw: Record<string, any> = {};
      const doc: any = {
        product_name: '',
        sku: '',
        colour: '',
        material: '',
        description: '',
        uom: '',
        price: '',
        source_file: fileName,
        source_sheet: sheetName,
        uploaded_at: new Date()
      };

      for (let c = 0; c < headers.length; c++) {
        const key = headers[c];
        const val = normalizeValue(r[c]);
        const rawKey = rawHeaders[c] || `col_${c}`;
        raw[rawKey] = val;
        if (key && key !== '_') {
          // Standard columns map directly; unknown columns land under raw only.
          if (
            key === 'product_name' ||
            key === 'sku' ||
            key === 'colour' ||
            key === 'material' ||
            key === 'description' ||
            key === 'uom' ||
            key === 'price' ||
            key === 'size' ||
            key === 'pack' ||
            key === 'length' ||
            key === 'category'
          ) {
            doc[key] = val;
          } else {
            doc[key] = val;
          }
        }
      }
      doc.raw = raw;

      // Carry product_name forward when Excel leaves it blank for grouped rows
      // (e.g. Fascia_Branch_Website.xlsx repeats only on the first row).
      if (!doc.product_name && docs.length) {
        const prev = docs[docs.length - 1];
        if (prev?.product_name) doc.product_name = prev.product_name;
      }

      // Skip rows with neither a SKU nor a description (almost always footer/legend).
      if (!String(doc.sku || '').trim() && !String(doc.description || '').trim()) continue;

      docs.push(doc);
    }

    let inserted = 0;
    if (docs.length) {
      const res = await col.insertMany(docs, { ordered: false });
      inserted = res.insertedCount;
    }
    result.sheets.push({ name: sheetName, rows: docs.length, inserted });
    result.total_rows += docs.length;
    result.total_inserted += inserted;
  }

  return result;
}

export async function catalogStatus(): Promise<{
  total: number;
  files: { source_file: string; count: number; uploaded_at: Date | null }[];
}> {
  const col = await getSkuCollection();
  const total = await col.countDocuments();
  const files = await col
    .aggregate([
      {
        $group: {
          _id: '$source_file',
          count: { $sum: 1 },
          uploaded_at: { $max: '$uploaded_at' }
        }
      },
      { $sort: { _id: 1 } }
    ])
    .toArray();
  return {
    total,
    files: files.map((f: any) => ({
      source_file: f._id,
      count: f.count,
      uploaded_at: f.uploaded_at || null
    }))
  };
}

export async function searchCatalog(q: string, limit = 30): Promise<any[]> {
  const col = await getSkuCollection();
  const trimmed = (q || '').trim();
  if (!trimmed) {
    return col.find({}, { projection: { _id: 0 } }).limit(limit).toArray();
  }
  // Use text index first, then fall back to substring on sku/product/description.
  try {
    const textHits = await col
      .find({ $text: { $search: trimmed } }, { projection: { _id: 0 } })
      .limit(limit)
      .toArray();
    if (textHits.length) return textHits;
  } catch {
    /* index may not be built yet on a fresh DB; fall through */
  }
  const safe = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return col
    .find(
      {
        $or: [
          { sku: { $regex: safe, $options: 'i' } },
          { product_name: { $regex: safe, $options: 'i' } },
          { description: { $regex: safe, $options: 'i' } }
        ]
      },
      { projection: { _id: 0 } }
    )
    .limit(limit)
    .toArray();
}

export async function deleteSource(sourceFile: string): Promise<number> {
  const col = await getSkuCollection();
  const res = await col.deleteMany({ source_file: sourceFile });
  return res.deletedCount || 0;
}

// ─── Roofing SKU auto-match ───────────────────────────────
// Given a roofing line (its generic description like "Ridge" and its specific
// profile like "Roll Top Ridge") plus the order colour ("Monument"), find the
// best-matching SKU in the uploaded catalog so the review screen pre-fills it.

export interface SkuMatchInput {
  description: string;
  profile: string;
}

export interface SkuMatchResult {
  sku: string;
  matched_product: string;
  matched_colour: string;
  score: number;
  confident: boolean;
}

// Words too generic to carry matching signal — dropped from both query and
// haystack token comparison.
const MATCH_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'a', 'of', 'to']);

function tokenize(s: string): string[] {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !MATCH_STOPWORDS.has(t));
}

// A catalog row's metal finish, derived from its material/description. The
// same product+colour usually exists in several finishes (e.g. Roll Top Ridge
// Monument comes as plain "Colorbond", "Colorbond Matt" and "Colorbond Ultra").
// "standard" = plain Colorbond, which is the default unless the order says
// otherwise.
type Finish = 'matt' | 'ultra' | 'standard';

function detectFinish(text: string): Finish {
  const s = text.toLowerCase();
  if (/\bmatt\b/.test(s)) return 'matt';
  if (/\bultra\b/.test(s)) return 'ultra';
  return 'standard';
}

export async function matchRoofingSkus(
  items: SkuMatchInput[],
  colour: string,
  // Anything that hints at the metal finish — typically the order's
  // roof_profile string. If it mentions "matt"/"ultra" we prefer those rows;
  // otherwise plain Colorbond wins.
  finishHint: string = ''
): Promise<SkuMatchResult[]> {
  const col = await getSkuCollection();
  const catalog = await col.find({}, { projection: { _id: 0 } }).toArray();
  const colourTokens = tokenize(colour);
  const orderFinish = detectFinish(finishHint);

  // Pre-tokenize every catalog row once so we don't re-parse per line item.
  const rows = catalog
    .map((row: any) => {
      const sku = String(row.sku || '').trim();
      if (!sku) return null;
      const haystack = `${row.product_name || ''} ${row.description || ''} ${
        row.material || ''
      } ${row.category || ''} ${row.size || ''}`.toLowerCase();
      const rowColour = String(row.colour || '').toLowerCase();
      return {
        sku,
        product: String(row.product_name || row.description || '').trim(),
        colour: String(row.colour || '').trim(),
        haystack,
        haystackTokens: new Set(tokenize(haystack)),
        finish: detectFinish(`${row.material || ''} ${row.description || ''}`),
        // A row "has a colour" only if its colour field is a real colour value.
        colourMatches:
          colourTokens.length > 0 &&
          rowColour.length > 0 &&
          colourTokens.some((t) => rowColour.includes(t)),
        hasColour: rowColour.length > 0
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return items.map((item) => {
    // The profile ("Roll Top Ridge") is the specific product signal; the
    // description ("Ridge") is generic. Use profile when present, else fall
    // back to description.
    const profileTokens = tokenize(item.profile);
    const descTokens = tokenize(item.description);
    const queryTokens = profileTokens.length ? profileTokens : descTokens;

    // If this specific line mentions a finish use it, else fall back to the
    // order-level hint (roof_profile). Plain Colorbond is the default.
    const lineFinish = detectFinish(`${item.profile} ${item.description}`);
    const wantFinish: Finish = lineFinish !== 'standard' ? lineFinish : orderFinish;

    const empty: SkuMatchResult = {
      sku: '',
      matched_product: '',
      matched_colour: '',
      score: 0,
      confident: false
    };
    if (!queryTokens.length) return empty;

    let best = empty;

    for (const row of rows) {
      let hits = 0;
      for (const t of queryTokens) {
        if (row.haystackTokens.has(t) || row.haystack.includes(t)) hits++;
      }
      if (hits === 0) continue;

      const coverage = hits / queryTokens.length;
      let score = hits * 2 + coverage * 3;

      // Bonus for matching the generic description tokens too (helps when the
      // profile is empty or unusual).
      for (const t of descTokens) {
        if (!queryTokens.includes(t) && row.haystack.includes(t)) score += 0.5;
      }

      // Colour: strong boost for a match, penalty for a row that carries a
      // *different* colour. Rows with no colour at all (screws, sisalation)
      // are left neutral.
      if (row.colourMatches) score += 6;
      else if (colourTokens.length && row.hasColour) score -= 4;

      // Finish: when the order doesn't ask for Matt/Ultra, plain Colorbond is
      // the intended product — so penalise Matt/Ultra rows hard enough that a
      // standard row always wins the tie. When the order DOES ask for a
      // finish, the matching finish gets the boost instead.
      if (row.finish === wantFinish) {
        if (wantFinish !== 'standard') score += 4;
      } else {
        score -= 8;
      }

      if (score > best.score) {
        best = {
          sku: row.sku,
          matched_product: row.product,
          matched_colour: row.colour,
          score,
          // Confident enough to auto-fill: at least half the query tokens hit
          // and, if the order has a colour, the row's colour agrees (or the
          // row has no colour to disagree with).
          confident:
            coverage >= 0.5 &&
            (!colourTokens.length || row.colourMatches || !row.hasColour)
        };
      }
    }

    return best;
  });
}
