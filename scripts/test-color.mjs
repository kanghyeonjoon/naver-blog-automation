// SE ONE 색 적용/해제 메커니즘 실험: 빨강 켜고 → 타이핑 → 검정으로 리셋 → 타이핑 → HTML 확인
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

async function openPalette(dataName) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await frame.locator(`button[data-name="${dataName}"]`).first().click().catch(() => {});
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(250);
      if (await frame.locator('button.se-color-palette').first().isVisible().catch(() => false)) return true;
    }
  }
  return false;
}
async function pickColor(dataName, match, label) {
  const ok = await openPalette(dataName);
  console.log(`palette open (${label}):`, ok);
  if (!ok) return false;
  const handle = await frame.evaluateHandle((m) => {
    const parse = (h) => { const x = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!x) return null; const n = parseInt(x[1], 16); return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 }; };
    const btns = [...document.querySelectorAll('button.se-color-palette')].filter((b) => b.offsetWidth || b.offsetHeight);
    const fns = {
      red: (c) => c.r > 180 && c.g < 90 && c.b < 90,
      black: (c) => c.r < 45 && c.g < 45 && c.b < 45,
    };
    const found = btns.find((b) => { const c = parse(b.getAttribute('data-color')); return c && fns[m](c); });
    return found || null;
  }, match);
  const el = handle.asElement();
  console.log(`swatch found (${label}):`, !!el, el ? await el.getAttribute('data-color') : '');
  if (!el) { await page.keyboard.press('Escape'); return false; }
  await el.click();
  await page.waitForTimeout(400);
  return true;
}

// 실험 1: 빨강 → "빨강테스트" → 검정 → "검정테스트"
await page.keyboard.insertText('일반텍스트 ');
const r1 = await pickColor('font-color', 'red', 'RED');
await page.keyboard.insertText('빨강테스트 ');
const r2 = await pickColor('font-color', 'black', 'BLACK');
await page.keyboard.insertText('검정테스트');
await page.waitForTimeout(500);

const html = await frame.evaluate(() => {
  const ps = [...document.querySelectorAll('.se-text-paragraph')];
  return ps.slice(-3).map((p) => p.innerHTML.slice(0, 400));
});
console.log('HTML:', JSON.stringify(html, null, 2));
await browser.close();
