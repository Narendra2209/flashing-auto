// Verify local cutting-list parsing against any real PDF.
//   npx tsx inspect-cutlist.ts "C:\path\to\roof-report.pdf"
// Prints the raw text and the parsed cuts so you can confirm values per file.
import { readFileSync } from 'node:fs';
import { extractPdfText } from './src/pdfToPng';
import { parseCuttingList, summaryRowForComponent, totalMetres } from './src/cuttingList';

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npx tsx inspect-cutlist.ts <path-to.pdf>');
    process.exit(1);
  }

  const buf = readFileSync(file);
  const pages = await extractPdfText(buf, { maxPages: 20 });
  const fullText = pages.map((p) => p.text).join('\n');

  console.log(`\n===== RAW TEXT (${pages.length} page(s)) =====`);
  console.log(fullText);

  console.log('\n===== PARSED CUTTING LIST =====');
  const blocks = parseCuttingList(fullText);
  if (!blocks.length) {
    console.log('(no cutting-list blocks found — PDF may be scanned/image-only)');
  }
  for (const b of blocks) {
    const cuts = b.cuts.map((c) => `${c.pieces}/${c.length_mm}`).join(', ');
    console.log(
      `${b.component.padEnd(12)} → [${summaryRowForComponent(b.component)}]  (${b.profile})`
    );
    console.log(`   cuts: ${cuts}`);
    console.log(
      `   pieces: ${b.cuts.reduce((a, c) => a + c.pieces, 0)}, total: ${totalMetres(b.cuts).toFixed(2)}m`
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
