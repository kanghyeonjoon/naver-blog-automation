// 스마트에디터 ONE 발행 레이어/드롭다운 구조 진단 + 취소선 토글 해제 (발행하지 않음)
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '..', 'data', 'auth', 'naver-session.json');
const OUT = path.join(__dirname, 'editor-dump2.json');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ storageState: SESSION_FILE, locale: 'ko-KR', viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
await page.goto('https://blog.naver.com/GoBlogWrite.naver', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

let frame = null;
for (let i = 0; i < 15 && !frame; i++) {
  for (const f of page.frames()) {
    try {
      if (await f.locator('.se-section-documentTitle').first().count()) { frame = f; break; }
    } catch {}
  }
  if (!frame) await page.waitForTimeout(1000);
}
if (!frame) { console.log('EDITOR NOT FOUND'); await browser.close(); process.exit(1); }

for (const sel of ['.se-popup-button-cancel', '.se-help-panel-close-button']) {
  try { const el = frame.locator(sel).first(); if (await el.count()) await el.click({ timeout: 1500 }); } catch {}
}
await page.waitForTimeout(1000);

const dump = {};

// 본문 클릭 → 스타일 토글 상태 확인 및 전부 해제
const body = frame.locator('.se-component-content .se-text-paragraph').last();
await body.click();
await page.waitForTimeout(500);
dump.togglesBefore = await frame.evaluate(() => {
  return ['bold', 'italic', 'underline', 'strikethrough'].map((n) => {
    const b = document.querySelector(`button[data-name="${n}"]`);
    return { name: n, selected: b ? b.classList.contains('se-is-selected') : null };
  });
});
for (const name of ['bold', 'italic', 'underline', 'strikethrough']) {
  const btn = frame.locator(`button[data-name="${name}"].se-is-selected`).first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(300); console.log('토글 해제:', name); }
}
dump.togglesAfter = await frame.evaluate(() => {
  return ['bold', 'italic', 'underline', 'strikethrough'].map((n) => {
    const b = document.querySelector(`button[data-name="${n}"]`);
    return { name: n, selected: b ? b.classList.contains('se-is-selected') : null };
  });
});

// 폰트크기 드롭다운 옵션 덤프
try {
  await frame.locator('.se-font-size-code-toolbar-button').first().click();
  await page.waitForTimeout(800);
  dump.fontSizeOptions = await frame.evaluate(() => {
    return [...document.querySelectorAll('.se-toolbar-option, [class*="option"]')]
      .filter((el) => !!(el.offsetWidth || el.offsetHeight))
      .flatMap((el) => [...el.querySelectorAll('button')])
      .map((b) => ({ cls: b.className.slice(0, 100), dataValue: b.getAttribute('data-value'), text: (b.innerText || '').trim().slice(0, 10) }))
      .filter((b, i, a) => a.findIndex((x) => x.text === b.text && x.cls === b.cls) === i)
      .slice(0, 30);
  });
  await page.keyboard.press('Escape');
} catch (e) { dump.fontSizeOptions = { error: e.message }; }
await page.waitForTimeout(500);

// 발행 레이어 열기 (frame 안 header의 publish_btn) → 레이어 덤프 → Escape
try {
  await frame.locator('button[class*="publish_btn"]').first().click({ timeout: 5000 });
  await page.waitForTimeout(2500);
  dump.publishLayer = await frame.evaluate(() => {
    // 레이어는 보통 별도 컨테이너 — 화면에 보이는 버튼 중 발행 관련 영역 전체 덤프
    const all = [...document.querySelectorAll('button')].filter((b) => !!(b.offsetWidth || b.offsetHeight));
    const btns = all.map((b) => ({ cls: b.className.slice(0, 120), dataTestid: b.getAttribute('data-testid'), dataClickArea: b.getAttribute('data-click-area'), text: (b.innerText || '').trim().slice(0, 30) }));
    const inputs = [...document.querySelectorAll('input')].filter((i) => !!(i.offsetWidth || i.offsetHeight)).map((i) => ({ cls: i.className.slice(0, 80), placeholder: i.placeholder, id: i.id, type: i.type, checked: i.checked }));
    const labels = [...document.querySelectorAll('label')].filter((l) => !!(l.offsetWidth || l.offsetHeight)).map((l) => (l.innerText || '').trim().slice(0, 25)).filter(Boolean);
    return { btns: btns.slice(-40), inputs: inputs.slice(0, 20), labels: labels.slice(0, 30) };
  });
  await page.keyboard.press('Escape');
} catch (e) { dump.publishLayer = { error: e.message }; }

fs.writeFileSync(OUT, JSON.stringify(dump, null, 2), 'utf-8');
console.log('DUMP2 SAVED');
await browser.close();
