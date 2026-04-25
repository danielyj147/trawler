import { Store } from './store.js';
import { parseMarkdownTable, parseUrlList } from './discovery/oss-lists.js';
import { discoverFromCommonCrawl } from './discovery/common-crawl.js';

async function main() {
  const dbPath = process.env.TRAWLER_DB || 'trawler.db';
  const store = new Store(dbPath);

  console.log('Trawler discovery');
  console.log(`  Database: ${dbPath}`);
  console.log(`  Existing universe: ${store.getCompanyCount()} companies`);
  console.log('');

  let totalNew = 0;

  // Common Crawl
  console.log('Querying Common Crawl index...');
  try {
    const results = await discoverFromCommonCrawl();
    let added = 0;
    for (const r of results) {
      const before = store.getCompanyCount();
      store.discoverCompany(r.company, { source_type: r.source_type, source_detail: r.source_detail });
      if (store.getCompanyCount() > before) added++;
    }
    totalNew += added;
    console.log(`  Common Crawl: ${results.length} found, ${added} new`);
  } catch (err) {
    console.error(`  Common Crawl failed: ${err}`);
  }

  console.log('');
  console.log(`Discovery complete. Universe: ${store.getCompanyCount()} companies (+${totalNew} new)`);
  console.log('');
  console.log('Next: start the scheduler with `npm start`');

  store.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
