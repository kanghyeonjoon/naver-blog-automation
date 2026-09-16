// SE ONE 글자색 팔레트 전체 색상 덤프
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '..', 'data', 'auth', 'naver-session.json');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ storageState: SESSION_FILE, locale: 'ko-KR', viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
await page.goto('https://blog.naver.com/GoBlogWrite.naver', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
let frame = null;
for (let i = 0; i < 15 && !frame; i++) {
  for (const f of page.frames()) {
    try { if (await f.locator('.se-section-documentTitle').first().count()) { frame = f; break; } } catch {}
  }
  if (!frame) await page.waitForTimeout(1000);
}
for (const sel of ['.se-popup-button-cancel', '.se-help-panel-close-button']) {
  try { const el = frame.locator(sel).first(); if (await el.count()) await el.click({ timeout: 1500 }); } catch {}
}
await frame.locator('.se-component-content .se-text-paragraph').last().click();
await page.waitForTimeout(500);

for (const name of ['font-color', 'background-color']) {
  await frame.locator(`button[data-name="${name}"]`).first().click().catch(() => {});
  await page.waitForTimeout(1200);
  const colors = await frame.evaluate(() =>
    [...document.querySelectorAll('button.se-color-palette')]
      .filter((b) => b.offsetWidth || b.offsetHeight)
      .map((b) => b.getAttribute('data-color'))
      .filter(Boolean)
  );
  console.log(`\n=== ${name} (${colors.length}개) ===`);
  console.log(colors.join(' '));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
}
await browser.close();
