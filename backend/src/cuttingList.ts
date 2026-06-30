// Deterministic parser for the "Cutting list" page of a Metfold Roof Report.
//
// The page is laid out as repeating blocks of:
//
//   <Component>, <Profile...>,
//   <pieces>/<length_mm>,  <pieces>/<length_mm>,  ...
//   (pairs may wrap across several lines until the next header)
//
// e.g.
//   Ridge, Roll Top Ridge,
//   1/7800,  1/7550,  1/3550,
//
// Parsing this from the raw text layer (extractPdfText) is exact — there is no
// guessing, so it does not need an LLM and cannot "take wrong values".

export interface ParsedCut {
  pieces: number;
  length_mm: number;
}

export interface ParsedCuttingBlock {
  /** First comma-field of the header, e.g. "Ridge", "Batten 1". */
  component: string;
  /** Remaining header text, e.g. "Roll Top Ridge", "Quad Gutter Slotted". */
  profile: string;
  cuts: ParsedCut[];
}

const PAIR_RE = /(\d+)\s*\/\s*(\d+)/g;

/** A line that is only pieces/length pairs (digits, slashes, commas, spaces). */
function isPairLine(line: string): boolean {
  return /\d+\s*\/\s*\d+/.test(line) && !/[A-Za-z]/.test(line);
}

/**
 * Parse the cutting-list text into blocks. Header lines (containing letters)
 * start a new block; following pair-only lines accumulate cuts into it.
 */
export function parseCuttingList(text: string): ParsedCuttingBlock[] {
  const blocks: ParsedCuttingBlock[] = [];
  let current: ParsedCuttingBlock | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isPairLine(line)) {
      if (!current) continue; // pairs before any header — ignore
      for (const m of line.matchAll(PAIR_RE)) {
        current.cuts.push({ pieces: Number(m[1]), length_mm: Number(m[2]) });
      }
      continue;
    }

    // Header line. Split on commas: first field = component, rest = profile.
    const fields = line.split(',').map((f) => f.trim()).filter(Boolean);
    if (!fields.length) continue;
    current = {
      component: fields[0],
      profile: fields.slice(1).join(', '),
      cuts: []
    };
    blocks.push(current);
  }

  return blocks.filter((b) => b.cuts.length > 0);
}

// Map a cutting-list component name → the matching Summary-table row label.
const COMPONENT_TO_SUMMARY: { test: RegExp; row: string }[] = [
  { test: /^ridge\b/i, row: 'Ridge' },
  { test: /^hip\b/i, row: 'Hip' },
  { test: /^valley\b/i, row: 'Valley' },
  { test: /^fascia\b/i, row: 'Fascia' },
  { test: /^gutter\b/i, row: 'Gutter' },
  { test: /^gable\b/i, row: 'Barge Capping' },
  { test: /^apron\b/i, row: 'Apron Flashing' },
  { test: /^batten/i, row: 'Roof Battens' }
];

export function summaryRowForComponent(component: string): string {
  const hit = COMPONENT_TO_SUMMARY.find((m) => m.test.test(component.trim()));
  return hit ? hit.row : component.trim();
}

/** sum(pieces × length_mm) / 1000 — total linear metres for a block. */
export function totalMetres(cuts: ParsedCut[]): number {
  return cuts.reduce((acc, c) => acc + c.pieces * c.length_mm, 0) / 1000;
}
