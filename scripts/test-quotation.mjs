// SE ONE 인용구 스타일 목록 + 탈출 방법 실험
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

// 1) 인용구 스타일 드롭다운 목록
await frame.locator('button[data-name="quotation"].se-document-toolbar-select-option-button, .se-document-toolbar-select-option-button').first().click().catch(() => {});
await page.waitForTimeout(1000);
const styles = await frame.evaluate(() =>
  [...document.querySelectorAll('button')]
    .filter((b) => (b.offsetWidth || b.offsetHeight) && /quotation/i.test(b.className + (b.getAttribute('data-name') || '')))
    .map((b) => ({ cls: String(b.className).slice(0, 100), dataValue: b.getAttribute('data-value'), text: (b.innerText || '').trim().slice(0, 20) }))
);
console.log('QUOTATION STYLES:', JSON.stringify(styles, null, 2));

// 2) 첫 스타일로 삽입 → 텍스트 → 탈출 실험
const target = styles.find((s) => s.dataValue && s.dataValue !== 'default');
if (target) {
  await frame.locator(`button[data-value="${target.dataValue}"]`).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.keyboard.insertText('소제목 실험 문구');
  await page.waitForTimeout(500);

  const inQuote = () => frame.evaluate(() => {
    const sel = window.getSelection();
    const el = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
    return !!(el && el.closest('.se-component.se-quotation'));
  }).catch(() => null);

  console.log('after insert, inQuote =', await inQuote());

  // 탈출 시도 A: 본문 영역 아래쪽 빈 공간 클릭 (실제 사용자가 하는 방법)
  const container = await frame.locator('.se-container, .se-content, .se-canvas').first().boundingBox().catch(() => null);
  if (container) {
    await page.mouse.click(container.x + container.width / 2, container.y + container.height - 15);
    await page.waitForTimeout(800);
    console.log('after bottom-click, inQuote =', await inQuote());
  } else {
    console.log('container box not found');
  }

  // 탈출 확인 후 텍스트 입력 테스트
  await page.keyboard.insertText('탈출후본문');
  await page.waitForTimeout(500);
  const html = await frame.evaluate(() => {
    const comps = [...document.querySelectorAll('.se-component')].slice(-3);
    return comps.map((c) => c.className.slice(0, 60) + ' :: ' + (c.innerText || '').slice(0, 40));
  });
  console.log('LAST COMPONENTS:', JSON.stringify(html, null, 2));
}
await page.screenshot({ path: path.join(__dirname, 'quotation-test.png') });
await browser.close();
