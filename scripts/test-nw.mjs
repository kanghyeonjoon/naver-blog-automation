import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(__dirname, '..', 'data', 'auth', 'clipartkorea-session.json');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ storageState: SESSION, locale: 'ko-KR', viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
await page.goto('https://www.clipartkorea.co.kr/search?keyword=' + encodeURIComponent('병원 접수'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const items = await page.evaluate(() =>
  [...document.querySelectorAll('.cksch_unit')].slice(0, 2).map(el => ({
    code: el.getAttribute('data-code'),
    preview: el.getAttribute('data-preview'),
    sm: el.getAttribute('data-sm'),
  }))
);
console.log(JSON.stringify(items, null, 2));

for (const [i, it] of items.entries()) {
  if (!it.preview) continue;
  const res = await context.request.get(it.preview);
  console.log(`\n[${i}] ${it.preview}`);
  console.log('   status:', res.status(), 'type:', res.headers()['content-type']);
  if (res.ok()) {
    const buf = await res.body();
    const fp = path.join(__dirname, `nw-test-${i}.jpg`);
    fs.writeFileSync(fp, buf);
    console.log('   저장:', fp, buf.length, 'bytes');
  }
}
await browser.close();
