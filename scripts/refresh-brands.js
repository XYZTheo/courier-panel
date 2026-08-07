// scripts/refresh-brands.js — pull all partner brands live and write companies.json.
const fs = require('fs');
const path = require('path');
const { fetchAllBrands } = require('../brandfetch');

const FILE = path.join(__dirname, '..', 'companies.json');

(async () => {
  console.log('Pulling brands from partner sites...');
  const brands = await fetchAllBrands();
  fs.writeFileSync(FILE, JSON.stringify(brands, null, 2));
  console.log(`\nWrote ${brands.length} brands to companies.json`);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
