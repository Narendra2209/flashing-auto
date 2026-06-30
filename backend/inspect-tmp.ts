import 'dotenv/config';
import { MongoClient } from 'mongodb';
(async () => {
  const c = new MongoClient(process.env.MONGODB_URI!);
  await c.connect();
  const col = c.db(process.env.MONGODB_DB || 'metfold').collection('sku_catalog');
  for (const term of ['batten', 'metal fascia', 'fascia', 'valley', 'quad gutter', 'gutter']) {
    const rows = await col.find({ $or: [
      { product_name: { $regex: term, $options: 'i' } },
      { description: { $regex: term, $options: 'i' } }
    ]}).limit(8).toArray();
    console.log(`\n=== "${term}" (${rows.length} shown) ===`);
    rows.forEach((r:any) => console.log(`  ${String(r.sku).padEnd(20)} | pn="${r.product_name}" | mat="${r.material}" | col="${r.colour}" | ${r.description}`));
  }
  // distinct product_names containing batten
  const names = await col.distinct('product_name', { product_name: { $regex: 'batten', $options: 'i' } });
  console.log('\ndistinct product_name ~batten:', names);
  await c.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
