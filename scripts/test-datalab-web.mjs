// 데이터랩 웹에서 트렌드 수치를 어떻게 얻을 수 있는지 탐색 (응답 로깅 + SVG 데이터 확인)
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const responses = [];
page.on('response', async (res) => {
  const req = res.request();
  if (!['xhr', 'fetch'].includes(req.resourceType())) return;
  let body = '';
  try { body = (await res.text()).slice(0, 500); } catch {}
  responses.push({ method: req.method(), url: res.url().slice(0, 140), status: res.status(), body: body.replace(/\s+/g, ' ') });
});

await page.goto('https://datalab.naver.com/keyword/trendSearch.naver', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// 주제어/키워드 입력 후 조회
await page.locator('#item_keyword1').first().fill('부천 임플란트').catch(() => {});
const kw = page.locator('input[placeholder*="키워드"]').first();
if (await kw.count()) { await kw.fill('부천 임플란트'); await kw.press('Enter'); }
await page.waitForTimeout(800);
responses.length = 0; // 조회 이후 응답만 보기
const btn = page.locator('a:has-text("네이버 검색 데이터 조회"), button:has-text("조회")').first();
if (await btn.count()) { await btn.click(); await page.waitForTimeout(6000); }

console.log('=== 조회 후 XHR/fetch 응답 ===');
for (const r of responses.slice(0, 8)) {
  console.log(`${r.method} ${r.status} ${r.url}`);
  console.log('   ', r.body.slice(0, 220));
}

// SVG/차트에서 값 추출 가능한지
const chart = await page.evaluate(() => {
  const svg = document.querySelector('.graph_wrap svg, svg');
  if (!svg) return { svg: false };
  const paths = [...svg.querySelectorAll('path')].map((p) => (p.getAttribute('d') || '').slice(0, 80));
  const texts = [...svg.querySelectorAll('text')].map((t) => t.textContent.trim()).filter(Boolean).slice(0, 20);
  // 툴팁/데이터 속성에 값이 있는지
  const dataEls = [...svg.querySelectorAll('[data-value], circle')].slice(0, 5)
    .map((e) => ({ tag: e.tagName, dv: e.getAttribute('data-value'), cx: e.getAttribute('cx'), cy: e.getAttribute('cy') }));
  return { svg: true, pathCount: paths.length, firstPath: paths[0], texts, dataEls };
});
console.log('\n=== 차트 구조 ===');
console.log(JSON.stringify(chart, null, 2).slice(0, 900));

// 다운로드 버튼 존재 여부
const dl = await page.locator('a:has-text("다운로드"), button:has-text("다운로드")').count();
console.log('\n다운로드 버튼:', dl);
await browser.close();
