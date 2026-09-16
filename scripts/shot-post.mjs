// 발행된 글(모바일 뷰)을 구간별 스크린샷 (확인용)
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '..', 'data', 'auth', 'naver-session.json');
const url = process.argv[2];
const prefix = process.argv[3] || path.join(__dirname, 'post');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ storageState: SESSION_FILE, locale: 'ko-KR', viewport: { width: 480, height: 1200 } });
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
// 팝업/배너 닫기 시도
for (const sel of ['button:has-text("닫기")', '[aria-label="닫기"]', 'button:has-text("취소")']) {
  try { const el = page.locator(sel).first(); if (await el.count()) await el.click({ timeout: 1000 }); } catch {}
}
console.log('URL:', page.url());
const title = await page.locator('.se-title-text').first().innerText().catch(() => '(제목 못 찾음)');
console.log('TITLE:', title.trim());
for (let i = 0; i < 4; i++) {
  await page.evaluate((y) => window.scrollTo(0, y), 400 + i * 2200);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${prefix}-${i + 1}.png` });
}
console.log('SAVED 4 shots');
await browser.close();
