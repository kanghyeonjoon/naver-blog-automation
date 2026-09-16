// 클립아트코리아: 썸네일 부모 구조 + 좌표 클릭으로 상세 이동 확인
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.goto('https://www.clipartkorea.co.kr/search?keyword=' + encodeURIComponent('병원 상담'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// 첫 썸네일의 부모 구조 덤프
const info = await page.evaluate(() => {
  const img = document.querySelector('img[src*="vrthumb"]');
  if (!img) return null;
  const chain = [];
  let el = img;
  for (let i = 0; i < 6 && el; i++) {
    chain.push({
      tag: el.tagName,
      cls: String(el.className).slice(0, 80),
      attrs: [...(el.attributes || [])].filter((a) => a.name.startsWith('data-') || a.name === 'onclick').map((a) => `${a.name}=${a.value.slice(0, 80)}`),
    });
    el = el.parentElement;
  }
  const r = img.getBoundingClientRect();
  return { chain, center: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
});
console.log('CHAIN:', JSON.stringify(info.chain, null, 2));

// 좌표로 직접 클릭 (오버레이 span 위라도 클릭 이벤트는 컨테이너로 전파됨)
const [newPage] = await Promise.all([
  context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
  page.mouse.click(info.center.x, info.center.y),
]);
await page.waitForTimeout(4000);
const target = newPage || page;
await target.waitForLoadState('domcontentloaded').catch(() => {});
await target.waitForTimeout(3000);
console.log('AFTER CLICK URL:', target.url());

const btns = await target.evaluate(() => {
  return [...document.querySelectorAll('a, button')]
    .filter((b) => !!(b.offsetWidth || b.offsetHeight))
    .filter((b) => /다운로드|download/i.test((b.innerText || '') + ' ' + (b.className || '')))
    .map((b) => ({ tag: b.tagName, cls: String(b.className).slice(0, 80), text: (b.innerText || '').trim().slice(0, 40), onclick: b.getAttribute('onclick') ? b.getAttribute('onclick').slice(0, 120) : null }))
    .slice(0, 10);
});
console.log('DOWNLOAD BTNS:', JSON.stringify(btns, null, 2));
await target.screenshot({ path: 'scripts/clipart-detail.png' });
await browser.close();
