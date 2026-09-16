// 클립아트코리아 세션 유효성 진단
import { chromium } from 'playwright';

const SESSION = 'F:/몽pd/블로그 자동화/data/auth/clipartkorea-session.json';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: SESSION, locale: 'ko-KR' });
const page = await context.newPage();
await page.goto('https://www.clipartkorea.co.kr', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const body = await page.evaluate(() => document.body.innerText || '');
const loggedIn = /로그아웃|마이페이지/.test(body);
console.log('로그인 상태:', loggedIn ? '✅ 유효' : '❌ 만료/비로그인');
if (loggedIn) {
  const m = body.match(/(다운로드|잔여|남은)[^\n]{0,40}/g);
  if (m) console.log('관련 문구:', m.slice(0, 5).join(' | '));
}
await browser.close();
