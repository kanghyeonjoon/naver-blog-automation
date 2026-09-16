// 클립아트코리아 멤버십 다운로드 흐름 진단 (로그인 세션 사용)
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(__dirname, '..', 'data', 'auth', 'clipartkorea-session.json');
const BASE = 'https://www.clipartkorea.co.kr';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ storageState: SESSION, locale: 'ko-KR', viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/search?keyword=${encodeURIComponent('병원 접수')}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// 로그인 상태 확인
const loggedIn = await page.evaluate(() => /로그아웃|마이페이지/.test(document.body.innerText || ''));
console.log('로그인 상태:', loggedIn);

const item = await page.evaluate(() => {
  const el = document.querySelector('.cksch_unit');
  return el ? { code: el.getAttribute('data-code'), preview: el.getAttribute('data-preview') } : null;
});
console.log('대상 아이템:', item);

// 상세(미리보기 팝업) 열기
const unit = page.locator(`.cksch_unit[data-code="${item.code}"]`).first();
await unit.scrollIntoViewIfNeeded();
await unit.click({ force: true });
await page.waitForTimeout(3000);
console.log('현재 URL:', page.url());

// 화면의 버튼들 덤프
const btns = await page.evaluate(() =>
  [...document.querySelectorAll('button, a')]
    .filter((b) => !!(b.offsetWidth || b.offsetHeight))
    .filter((b) => /다운|down|저장|구매/i.test((b.innerText || '') + ' ' + b.className))
    .map((b) => ({ tag: b.tagName, cls: String(b.className).slice(0, 80), text: (b.innerText || '').trim().slice(0, 30), href: b.href ? b.href.slice(0, 100) : null }))
    .slice(0, 12)
);
console.log('다운로드 관련 버튼:', JSON.stringify(btns, null, 2));

// 멤버십 다운로드 클릭 → 무엇이 뜨는지
try {
  const down = page.locator('button.mega-btn__down, button:has-text("멤버십 다운로드")').first();
  if (await down.count()) {
    // 다운로드 이벤트와 새 창 모두 감시
    const dlPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await down.click();
    await page.waitForTimeout(3000);

    const dl = await dlPromise;
    const popup = await popupPromise;
    console.log('download 이벤트:', dl ? dl.suggestedFilename() : '없음');
    console.log('새 창:', popup ? popup.url().slice(0, 120) : '없음');

    // 클릭 후 화면 상태
    const after = await page.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
      const layers = [...document.querySelectorAll('[class*="layer"], [class*="popup"], [class*="modal"]')]
        .filter(vis)
        .map((l) => ({ cls: String(l.className).slice(0, 70), text: (l.innerText || '').replace(/\s+/g, ' ').slice(0, 150) }));
      const buttons = [...document.querySelectorAll('button, a')]
        .filter(vis)
        .filter((b) => /다운|확인|선택|크기|원본/i.test(b.innerText || ''))
        .map((b) => ({ cls: String(b.className).slice(0, 60), text: (b.innerText || '').trim().slice(0, 25) }))
        .slice(0, 10);
      return { layers: layers.slice(0, 4), buttons };
    });
    console.log('클릭 후 화면:', JSON.stringify(after, null, 2));
  } else {
    console.log('멤버십 다운로드 버튼 없음');
  }
} catch (e) {
  console.log('오류:', e.message.split('\n')[0]);
}
await page.screenshot({ path: path.join(__dirname, 'clipart-download.png') });
await browser.close();
