require('dotenv').config();
require('ts-node/register');
const { matchRoofingSkus } = require('./src/skuCatalog');
(async () => {
  const items = [
    { description: 'Ridge', profile: 'Roll Top Ridge' },
    { description: 'Hip', profile: 'Roll Top Ridge' },
    { description: 'Valley', profile: 'Valley, CB' },
    { description: 'Fascia', profile: 'Metal Fascia' },
    { description: 'Gutter', profile: 'Quad Gutter Slotted' },
    { description: 'Roof Battens', profile: 'Roof Batten 40mm X 7.5M Zincalume' },
    { description: 'Downpipes', profile: '' }
  ];
  console.log('--- colour=Monument, roof_profile="Colorbond .42 BMT CB" ---');
  let r = await matchRoofingSkus(items, 'Monument', 'Colorbond .42 BMT CB');
  items.forEach((it, i) => console.log(`${it.description.padEnd(14)} | ${(r[i].sku||'(none)').padEnd(16)} | conf=${r[i].confident} | ${r[i].matched_product} [${r[i].matched_colour}] score=${r[i].score.toFixed(1)}`));
  console.log('\n--- colour=Monument, roof_profile mentions MATT ---');
  r = await matchRoofingSkus([items[0]], 'Monument', 'Colorbond Matt .42');
  console.log(`${items[0].description.padEnd(14)} | ${r[0].sku} | ${r[0].matched_product}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
