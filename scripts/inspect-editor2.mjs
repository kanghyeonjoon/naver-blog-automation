// SE ONE: 정렬 드롭다운 + 글자색 팔레트 구조 진단 (발행 안 함)
import { chromium } from 'playwright';
import fs from 'fs';
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
await page.waitForTimeout(800);
await frame.locator('.se-component-content .se-text-paragraph').last().click();
await page.waitForTimeout(500);

const dump = {};

// 정렬 드롭다운
try {
  await frame.locator('button[data-name="align-drop-down-with-justify"]').first().click();
  await page.waitForTimeout(800);
  dump.alignOptions = await frame.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b) => !!(b.offsetWidth || b.offsetHeight))
      .filter((b) => /align/i.test(b.className) || /정렬/.test(b.innerText || ''))
      .map((b) => ({ cls: String(b.className).slice(0, 90), dataValue: b.getAttribute('data-value'), dataName: b.getAttribute('data-name'), text: (b.innerText || '').trim().slice(0, 20) }))
      .slice(0, 12)
  );
  await page.keyboard.press('Escape');
} catch (e) { dump.alignOptions = { error: e.message.split('\n')[0] }; }
await page.waitForTimeout(500);

// 글자색 팔레트
try {
  await frame.locator('button[data-name="font-color"]').first().click();
  await page.waitForTimeout(1000);
  dump.colorPalette = await frame.evaluate(() => {
    const swatches = [...document.querySelectorAll('button, li, span')]
      .filter((el) => !!(el.offsetWidth || el.offsetHeight))
      .filter((el) => {
        const dv = el.getAttribute && el.getAttribute('data-value');
        const dc = el.getAttribute && el.getAttribute('data-color');
        return (dv && /^#?[0-9a-f]{6}$/i.test(dv)) || (dc && /^#?[0-9a-f]{6}$/i.test(dc)) || /palette|color-picker|se-color/i.test(el.className || '');
      })
      .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 80), dataValue: el.getAttribute('data-value'), dataColor: el.getAttribute('data-color'), title: el.getAttribute('title'), aria: el.getAttribute('aria-label') }))
      .slice(0, 25);
    return swatches;
  });
  await page.keyboard.press('Escape');
} catch (e) { dump.colorPalette = { error: e.message.split('\n')[0] }; }

fs.writeFileSync(path.join(__dirname, 'editor-dump3.json'), JSON.stringify(dump, null, 2), 'utf-8');
console.log('SAVED editor-dump3.json');
await browser.close();
