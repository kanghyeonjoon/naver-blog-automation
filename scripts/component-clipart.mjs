// 더컴포넌트 영상용 클립아트코리아 다운로드 (멤버십 다운로드 — 상세 URL 직접 진입 방식)
// 사용: node component-clipart.mjs [limit]
// 산출: F:/더 컴포넌트/더컴포넌트 대본 작성/EP02_클립아트/*.jpg
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SESSION = 'F:/몽pd/블로그 자동화/data/auth/clipartkorea-session.json';
const USED_FILE = 'F:/몽pd/블로그 자동화/data/used-images.json';
const OUT_DIR = 'F:/더 컴포넌트/더컴포넌트 대본 작성/EP02_클립아트';
const BASE = 'https://www.clipartkorea.co.kr';

const JOBS = [
  { query: '주방 인테리어', name: '01_주방인테리어_완성샷' },
  { query: '아일랜드 주방', name: '02_아일랜드주방_대면형' },
  { query: '가족 요리', name: '03_가족요리_대화' },
  { query: '미니멀 주방', name: '04_미니멀주방_상부장없는' },
  { query: '주방 선반', name: '05_오픈선반' },
  { query: '주방 수납', name: '06_주방수납_내부' },
  { query: '밥솥', name: '07_밥솥' },
  { query: '에어프라이어', name: '08_에어프라이어' },
  { query: '커피머신', name: '09_커피머신' },
  { query: '멀티탭', name: '10_멀티탭_콘센트' },
  { query: '경첩', name: '11_경첩_하드웨어' },
  { query: '서랍', name: '12_서랍_레일' },
  { query: '싱크대', name: '13_싱크대' },
  { query: '도마 요리', name: '14_도마_손질' },
  { query: '목공', name: '15_공장_가공' },
  { query: '설계 도면', name: '16_설계도면' },
  { query: '냉장고', name: '17_빌트인가전' },
];

function loadUsed() {
  try { return new Set(JSON.parse(fs.readFileSync(USED_FILE, 'utf-8'))); } catch { return new Set(); }
}
function saveUsed(set) {
  try { fs.writeFileSync(USED_FILE, JSON.stringify([...set].slice(-500)), 'utf-8'); } catch {}
}

// 사용: node component-clipart.mjs [시작번호] [개수]  (예: 2 16 = 2번부터 16개)
const startArg = Number(process.argv[2]) || 1;
const countArg = Number(process.argv[3]) || (JOBS.length - startArg + 1);
const jobs = JOBS.slice(startArg - 1, startArg - 1 + countArg);
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: SESSION,
  locale: 'ko-KR',
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
});
const used = loadUsed();
const usedNow = new Set();
let ok = 0;

try {
  const page = await context.newPage();
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const filePath = path.join(OUT_DIR, `${job.name}.jpg`);
    try {
      console.log(`[${i + 1}/${jobs.length}] 검색: "${job.query}"`);
      await page.goto(`${BASE}/search?keyword=${encodeURIComponent(job.query)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      const items = await page.evaluate(() =>
        [...document.querySelectorAll('.cksch_unit')]
          .map((el) => ({ code: el.getAttribute('data-code'), preview: el.getAttribute('data-preview') }))
          .filter((it) => it.code)
      );
      if (!items.length) { console.log('  ⚠ 검색 결과 없음'); continue; }
      const fresh = items.filter((it) => !used.has(it.code) && !usedNow.has(it.code));
      const basePool = fresh.length ? fresh : items.filter((it) => !usedNow.has(it.code));

      // 벡터(ai/eps/psd)가 걸리면 다른 후보로 최대 3회 재시도
      let saved = false;
      let item = null;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        const cand = basePool.filter((it) => !usedNow.has(it.code));
        item = cand[Math.floor(Math.random() * Math.min(cand.length, 12))] || items[0];
        if (!item) break;
        usedNow.add(item.code);

        await page.goto(`${BASE}/search/preview?cont_code=${item.code}&popYn=Y&vt=popup`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        const btn = page.locator('button.mega-btn__down, button:has-text("멤버십 다운로드")').first();
        if (!(await btn.count())) { console.log('  ⚠ 멤버십 다운로드 버튼 없음'); continue; }
        try {
          const dlPromise = page.waitForEvent('download', { timeout: 20000 });
          await btn.click();
          await page.waitForTimeout(1200);
          // 옵션 레이어: "JPG 다운받기"(원본 해상도) 우선, 없으면 레이어 첫 항목
          const optBtn = page.locator('.mg-layer__item:has-text("JPG 다운받기"), .mg-layer__item').first();
          if (await optBtn.count().catch(() => 0)) await optBtn.click({ timeout: 3000 }).catch(() => {});
          const dl = await dlPromise;
          const suggested = dl.suggestedFilename() || '';
          if (/\.(jpe?g|png)$/i.test(suggested)) {
            await dl.saveAs(filePath);
            saved = true;
            console.log(`  ✅ 멤버십 다운로드 (${suggested})`);
          } else {
            await dl.cancel().catch(() => {});
            console.log(`  ⚠ 사진이 아닌 소스(${suggested}) — 다른 후보 시도`);
          }
        } catch (e) {
          console.log(`  ⚠ 다운로드 실패: ${e.message.split('\n')[0]}`);
        }
      }

      if (!saved && item && item.preview) {
        const res = await context.request.get(item.preview);
        if (res.ok()) {
          const buf = await res.body();
          if (buf.length > 5000) { fs.writeFileSync(filePath, buf); saved = true; console.log('  ✅ 미리보기 저장'); }
        }
      }
      if (saved) { ok++; used.add(item.code); }
      await page.waitForTimeout(800);
    } catch (e) {
      console.log(`  ⚠ 오류: ${e.message.split('\n')[0]}`);
    }
  }
} finally {
  saveUsed(used);
  await browser.close().catch(() => {});
}
console.log(`\n완료: ${ok}/${jobs.length}개 → ${OUT_DIR}`);
