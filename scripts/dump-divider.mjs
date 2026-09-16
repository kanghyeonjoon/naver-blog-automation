// SE ONE 구분선 스타일 목록 덤프 (소제목 아래 선을 원고처럼 전체 폭으로 바꾸기 위함)
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

// 구분선 스타일 드롭다운
await frame.locator('button[data-name="horizontal-line"].se-document-toolbar-select-option-button, .se-document-toolbar-select-option-button').nth(1).click().catch(() => {});
await page.waitForTimeout(1000);
const styles = await frame.evaluate(() =>
  [...document.querySelectorAll('button')]
    .filter((b) => (b.offsetWidth || b.offsetHeight) && /horizontal-line/i.test(b.className + (b.getAttribute('data-name') || '')))
    .map((b) => ({ cls: String(b.className).slice(0, 100), dataValue: b.getAttribute('data-value'), text: (b.innerText || '').trim().slice(0, 20) }))
);
console.log('DIVIDER STYLES:', JSON.stringify(styles, null, 2));
await page.screenshot({ path: path.join(__dirname, 'divider-styles.png') });
await browser.close();
