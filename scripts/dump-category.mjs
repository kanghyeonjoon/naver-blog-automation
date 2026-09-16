// 발행 레이어의 카테고리 선택 UI 구조 + 카테고리 목록 덤프 (발행하지 않음)
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
// 제목만 넣어야 발행 레이어가 열림
await frame.locator('.se-section-documentTitle').first().click();
await page.keyboard.insertText('카테고리 진단용');
await page.waitForTimeout(800);

// 발행 레이어 열기 (태그 입력창이 보이면 열린 것)
await frame.locator('button[class*="publish_btn"]').first().click({ timeout: 5000 });
await frame.locator('#tag-input').first().waitFor({ state: 'visible', timeout: 10000 });
await page.waitForTimeout(1000);
console.log('발행 레이어 열림 확인');

// "카테고리" 레이블 옆의 실제 컨트롤을 찾는다
const dump = await frame.evaluate(() => {
  const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
  const label = [...document.querySelectorAll('*')]
    .filter((el) => vis(el) && (el.innerText || '').trim() === '카테고리' && el.children.length === 0)[0];
  if (!label) return { found: false };
  let container = label.parentElement;
  for (let i = 0; i < 4 && container; i++) {
    const ctrls = [...container.querySelectorAll('select, button, input, div[role="button"], [class*="select"], [class*="dropdown"]')]
      .filter(vis)
      .filter((c) => !/se-flayer|se-toolbar/.test(c.className));
    if (ctrls.length) {
      return {
        found: true,
        containerCls: String(container.className).slice(0, 60),
        ctrls: ctrls.slice(0, 6).map((c) => ({
          tag: c.tagName, cls: String(c.className).slice(0, 80), id: c.id,
          text: (c.innerText || c.value || '').trim().slice(0, 30),
          options: c.tagName === 'SELECT' ? [...c.options].map((o) => o.text.trim()).slice(0, 20) : null,
        })),
      };
    }
    container = container.parentElement;
  }
  return { found: true, ctrls: [] };
});
console.log('CATEGORY CONTROL:', JSON.stringify(dump, null, 2));

// 컨트롤 클릭 → 목록 덤프
try {
  const sel = dump.ctrls && dump.ctrls[0];
  if (sel && sel.tag !== 'SELECT') {
    const loc = sel.id ? frame.locator(`#${sel.id}`) : frame.locator(`.${sel.cls.split(' ')[0]}`).first();
    await loc.click({ timeout: 4000 });
    await page.waitForTimeout(1200);
    const list = await frame.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
      return [...document.querySelectorAll('li, label, button')]
        .filter(vis)
        .filter((el) => !/se-flayer|se-toolbar/.test(el.className))
        .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), text: (el.innerText || '').trim().slice(0, 25) }))
        .filter((x) => x.text && x.text.length > 1 && !/발행|예약|공개|태그|저장|사진|동영상/.test(x.text))
        .slice(0, 30);
    });
    console.log('CATEGORY LIST:', JSON.stringify(list, null, 2));
  }
} catch (e) {
  console.log('category open failed:', e.message.split('\n')[0]);
}
await page.screenshot({ path: path.join(__dirname, 'category-ui.png') });
await browser.close();
