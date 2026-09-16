import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { AUTH_DIR, DATA_DIR } from './files.js';

/**
 * 병원 콘텐츠에 쓰면 안 되는 소재. alt에 이 단어가 있으면 검색어와 몇 개 겹쳐도 제외한다.
 * (검색어 자체에 해당 단어가 들어 있으면 의도한 것이므로 예외로 둔다)
 */
const OFF_TOPIC = [
  // 고용·급여
  '알바', '아르바이트', '최저시급', '최저임금', '퇴직금', '주휴수당', '연봉', '취업', '이력서', '면접',
  // 금융·부동산
  '부동산', '아파트', '전세', '월세', '청약', '대출', '주식', '코인', '투자', '보험설계', '세금', '연말정산',
  // 생활·소비
  '쇼핑', '택배', '배달', '카페', '음식', '요리', '레시피', '여행', '캠핑', '반려동물',
  '학원', '입시', '수능', '군대', '결혼', '웨딩', '육아용품', '자동차', '주유',
  // 시사·정치 (검색어 "회의"에 한미정상회담 일러스트가 걸려 들어온 사고 대응)
  '정상회담', '회담', '국기', '태극기', '성조기', '외교', '정치', '선거', '투표', '대통령',
  '국회', '시위', '집회', '전쟁', '군사', '무역', '수출', '환율', '올림픽', '월드컵',
];

// 이미 쓴 이미지가 다른 글에 또 나오지 않도록 사용 이력을 남긴다
const USED_IMAGES_FILE = path.join(DATA_DIR, 'used-images.json');

function loadUsedCodes() {
  try {
    const data = JSON.parse(fs.readFileSync(USED_IMAGES_FILE, 'utf-8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveUsedCodes(set) {
  try {
    // 너무 커지지 않게 최근 500개만 유지
    const arr = [...set].slice(-500);
    fs.writeFileSync(USED_IMAGES_FILE, JSON.stringify(arr), 'utf-8');
  } catch { /* 무시 */ }
}

export function usedImageCount() {
  return loadUsedCodes().size;
}

export function resetUsedImages() {
  try { fs.unlinkSync(USED_IMAGES_FILE); } catch { /* 없으면 무시 */ }
}

/**
 * 클립아트코리아(유료 멤버십) 연동.
 * 공개 API가 없어 Playwright로 사용자의 로그인 세션을 재사용한다:
 * 검색(/search?keyword=) → 첫 결과(.cksch_unit) → 미리보기 팝업 → "멤버십 다운로드".
 * 다운로드 실패 시 data-preview(미리보기 원본)로 폴백.
 */

export const CLIPART_SESSION_FILE = path.join(AUTH_DIR, 'clipartkorea-session.json');
const BASE = 'https://www.clipartkorea.co.kr';

export function hasClipartSession() {
  return fs.existsSync(CLIPART_SESSION_FILE);
}

/**
 * 클립아트코리아 세션이 유효한지 빠르게 확인 (약 10초).
 * 로그인 상태에서만 이미지 주소가 previewnw(워터마크 없음)로 내려오는 점을 이용한다.
 */
export async function checkClipartSession() {
  if (!hasClipartSession()) return { ok: false, reason: '저장된 클립아트코리아 로그인 세션이 없습니다.' };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: CLIPART_SESSION_FILE, locale: 'ko-KR' });
    const page = await context.newPage();
    await page.goto(`${BASE}/search?keyword=${encodeURIComponent('병원')}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3500);
    const hasNw = await page.evaluate(() => {
      const units = [...document.querySelectorAll('.cksch_unit')].slice(0, 5);
      if (!units.length) return null;
      return units.some((el) => /previewnw/.test(el.getAttribute('data-preview') || ''));
    }).catch(() => null);
    if (hasNw === false) {
      return { ok: false, reason: '클립아트코리아 세션이 만료되었습니다. 설정 탭에서 "클립아트코리아 로그인"을 다시 실행해 주세요.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: true, warn: `세션 확인 실패: ${e.message.split('\n')[0]}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export function clipartSessionInfo() {
  if (!hasClipartSession()) return { exists: false };
  const st = fs.statSync(CLIPART_SESSION_FILE);
  return { exists: true, savedAt: st.mtimeMs };
}

/**
 * 브라우저를 띄워 사용자가 직접 로그인 → "로그아웃" 표시 감지로 완료 판정 → 세션 저장.
 * 구글 소셜 로그인이 자동화 브라우저를 차단하므로, 실제 크롬 채널 + 자동화 흔적 제거로 실행한다.
 */
export async function saveClipartLoginSession(log) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  log('브라우저를 실행합니다. 열린 창에서 클립아트코리아에 로그인해 주세요.');
  let browser;
  try {
    // 실제 크롬(설치돼 있으면)으로 실행 — 구글 로그인 차단 회피
    browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch {
    browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }
  const context = await browser.newContext({ locale: 'ko-KR' });
  // navigator.webdriver 흔적 제거
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  log('로그인 대기 중... (최대 5분) — 로그인 후 창을 닫지 마세요, 자동으로 감지합니다.');
  const deadline = Date.now() + 5 * 60 * 1000;
  const earliest = Date.now() + 8 * 1000; // 창이 뜨자마자 오판으로 닫히는 것 방지
  let loggedIn = false;
  let notified = false;
  let hits = 0;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    if (Date.now() < earliest) { await page.waitForTimeout(1000); continue; }
    // 감지 방법을 셋으로 늘렸다. 예전엔 화면에 "로그아웃/마이페이지" 글자가 보이는지만 봤는데,
    // 로그인 후 이동한 페이지에 그 단어가 없으면 로그인해도 감지를 못 하는 문제가 있었다.
    const ok = await page.evaluate(() => {
      const txt = document.body.innerText || '';
      // ① 화면 문구
      if (/로그아웃|마이페이지|마이클립|보관함/.test(txt)) return true;
      // ② 로그아웃 링크 (문구가 이미지로 되어 있어도 잡힌다)
      //    ※ mypage 링크는 쓰면 안 된다. 로그아웃 상태에도 "/mypage/info_modify_intro"
      //      (회원정보 업데이트) 링크가 있어서, 로그인 전에 창이 닫히는 사고가 났다.
      if (document.querySelector('a[href*="logout" i], a[href*="Logout"]')) return true;
      // ※ "로그인 링크가 없으면 로그인된 것"으로 보던 판정은 뺐다.
      //    페이지가 아직 안 그려진 순간에 즉시 참이 되어, 로그인도 하기 전에 창이 닫히는 사고가 났다.
      return false;
    }).catch(() => false);
    if (ok) {
      hits += 1;
      if (hits >= 2) { loggedIn = true; break; } // 한 번만 보고 닫지 않는다
    } else {
      hits = 0;
    }
    if (!notified && Date.now() > deadline - 4 * 60 * 1000) {
      notified = true;
      log('아직 로그인이 감지되지 않았습니다. 로그인하셨다면 잠시만 기다려 주세요.');
    }
    await page.waitForTimeout(2000);
  }

  // 화면으로 감지가 안 됐어도, 로그인 쿠키가 있으면 로그인된 것으로 본다 (최후 확인)
  if (!loggedIn && !page.isClosed()) {
    const cookies = await context.cookies().catch(() => []);
    const auth = cookies.filter(
      (c) =>
        /member|login|auth|user/i.test(c.name) &&
        !/^JSESSIONID$/i.test(c.name) && // 로그인 전에도 발급되므로 근거가 안 된다
        c.value &&
        c.value.length > 8
    );
    if (auth.length) {
      loggedIn = true;
      log(`로그인 쿠키가 확인되어 세션을 저장합니다. (${auth.length}개)`);
    }
  }

  if (!loggedIn) {
    await browser.close().catch(() => {});
    throw new Error('로그인이 감지되지 않았습니다. 다시 시도해 주세요.');
  }
  await page.waitForTimeout(2000);
  await context.storageState({ path: CLIPART_SESSION_FILE });
  await browser.close();
  log('클립아트코리아 로그인 세션이 저장되었습니다.');
  return true;
}

/** 검색 결과 첫 페이지에서 아이템 목록(data-code, data-preview) 수집 */
async function collectItems(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('.cksch_unit')]
      .map((el) => {
        const img = el.querySelector('img');
        return {
          code: el.getAttribute('data-code'),
          preview: el.getAttribute('data-preview'),
          group: el.getAttribute('data-group'),
          // 클립아트 이미지의 alt에는 그 사진을 설명하는 키워드가 나열되어 있다 → 관련성 판정에 쓴다
          alt: img ? (img.getAttribute('alt') || '') : '',
        };
      })
      .filter((it) => it.code);
  });
}

/**
 * 여러 검색어의 이미지를 한 브라우저 세션에서 순서대로 다운로드.
 * @param jobs [{ query, filePath, index }]
 * @returns 성공한 filePath 목록
 */
export async function downloadClipartImages({ jobs, log }) {
  if (!hasClipartSession()) throw new Error('클립아트코리아 로그인 세션이 없습니다.');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: CLIPART_SESSION_FILE,
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });
  const done = [];
  const usedCodes = loadUsedCodes();   // 지난 글들에서 이미 쓴 이미지
  const usedNow = new Set();           // 이번 글 안에서 쓴 이미지
  try {
    const page = await context.newPage();

    // 세션이 만료되면 워터마크 이미지만 받게 되므로 먼저 확인한다.
    // 판정 기준은 화면의 "로그아웃" 글자가 아니라 실제 이미지 주소다 —
    // 로그인 상태에서만 previewnw(워터마크 없음)로 내려오므로 이게 가장 정확하다.
    // (메인 페이지 텍스트로 판정했더니 로딩 타이밍 때문에 멀쩡한 세션을 만료로 오판했음)
    let hasNw = null;
    for (let attempt = 0; attempt < 2 && hasNw !== true; attempt++) {
      await page.goto(`${BASE}/search?keyword=${encodeURIComponent('병원')}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      hasNw = await page.evaluate(() => {
        const units = [...document.querySelectorAll('.cksch_unit')].slice(0, 5);
        if (!units.length) return null; // 검색 결과 자체를 못 읽음
        return units.some((el) => /previewnw/.test(el.getAttribute('data-preview') || ''));
      }).catch(() => null);
    }
    if (hasNw === false) {
      throw new Error('클립아트코리아 로그인 세션이 만료되었습니다. 설정 탭에서 "클립아트코리아 로그인"을 다시 실행해 주세요.');
    }
    if (hasNw === null) {
      log('⚠ 로그인 상태를 확인하지 못했습니다 — 워터마크 판별은 이미지별로 계속 검사합니다.');
    }

    for (const job of jobs) {
      try {
        log(`[이미지 ${job.index}] 클립아트코리아 검색: "${job.query}"`);
        await page.goto(`${BASE}/search?keyword=${encodeURIComponent(job.query)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);
        const items = await collectItems(page);
        if (!items.length) {
          log(`[이미지 ${job.index}] ⚠ 검색 결과 없음`);
          continue;
        }
        // ① 검색어와 실제로 관련 있는 사진만 남긴다.
        //    (검색 결과 뒤쪽에는 무관한 사진이 섞여 있어, 그냥 무작위로 고르면
        //     "병원 상담" 검색에 요양병원 사진이 들어가는 사고가 난다)
        const tokens = job.query.split(/\s+/).filter((t) => t.length >= 2);
        // alt는 "회의 비즈니스 미팅 상담..." 처럼 단어가 나열돼 있어 검색어와 완전히 같지 않다
        // → 토큰의 앞 2글자만 겹쳐도 맞는 것으로 본다 ("회의실"↔"회의", "계약서"↔"계약")
        const hitCount = (alt) => tokens.filter((t) => alt.includes(t) || alt.includes(t.slice(0, 2))).length;

        // 병원 글에 절대 어울리지 않는 업종·소재는 단어가 몇 개 겹쳐도 제외한다.
        // ("스마트폰 리뷰 확인" 검색에 '알바 최저시급/퇴직금' 일러스트가 들어간 사고 대응)
        const isOffTopic = (alt) =>
          OFF_TOPIC.some((w) => alt.includes(w)) && !tokens.some((t) => OFF_TOPIC.includes(t));

        // 1차: 두 단어 이상 맞는 사진 (가장 확실)
        let relevant = items.filter((it) => it.alt && !isOffTopic(it.alt) && hitCount(it.alt) >= 2);
        // 2차: 없으면 한 단어라도 맞는 사진 중 검색 상위 8개 안에서만 (상위일수록 관련성이 높다)
        if (!relevant.length) {
          relevant = items.slice(0, 8).filter((it) => it.alt && !isOffTopic(it.alt) && hitCount(it.alt) >= 1);
          if (relevant.length) log(`[이미지 ${job.index}] (정확히 맞는 사진이 없어 상위 결과에서 선택)`);
        }
        if (!relevant.length) {
          log(`[이미지 ${job.index}] ⚠ "${job.query}"와 맞는 사진이 없어 건너뜁니다 (무관한 사진을 넣지 않습니다)`);
          continue;
        }

        // ② 지난 글·이번 글에서 쓰지 않은 것 중에서 고른다 (같은 사진 반복 방지)
        const fresh = relevant.filter((it) => !usedCodes.has(it.code) && !usedNow.has(it.code));
        const pool = fresh.length ? fresh : relevant.filter((it) => !usedNow.has(it.code));
        if (!pool.length) {
          log(`[이미지 ${job.index}] ⚠ 쓸 수 있는 새 사진이 없어 건너뜁니다`);
          continue;
        }
        if (!fresh.length) log(`[이미지 ${job.index}] (새 사진이 없어 기존에 쓴 사진에서 선택)`);
        // 관련성 높은 상위 6개 안에서만 무작위 — 매번 같은 사진이 나오는 것도 막고, 엉뚱한 사진도 막는다
        const item = pool[Math.floor(Math.random() * Math.min(pool.length, 6))];
        usedNow.add(item.code);
        log(`[이미지 ${job.index}] 선택: ${(item.alt || '').slice(0, 40)}`);

        let saved = false;
        // 1차: 미리보기 팝업 열어 "멤버십 다운로드" (정식 라이선스 다운로드)
        try {
          const unit = page.locator(`.cksch_unit[data-code="${item.code}"]`).first();
          await unit.scrollIntoViewIfNeeded();
          await unit.click({ force: true, timeout: 5000 });
          await page.waitForTimeout(2500);
          const downBtn = page.locator('button.mega-btn__down, button:has-text("멤버십 다운로드")').first();
          if (await downBtn.count()) {
            const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
            await downBtn.click();
            // 크기/옵션 선택 레이어가 뜨는 경우 첫 다운로드 항목 클릭
            await page.waitForTimeout(1200);
            const optBtn = page.locator('button:has-text("다운로드"), a:has-text("다운로드")').first();
            if (await optBtn.count().catch(() => 0)) await optBtn.click({ timeout: 2000 }).catch(() => {});
            const download = await downloadPromise;
            const suggested = download.suggestedFilename() || '';
            if (/\.(jpe?g|png)$/i.test(suggested)) {
              await download.saveAs(job.filePath);
              saved = true;
              log(`[이미지 ${job.index}] ✅ 멤버십 다운로드 완료 (${suggested})`);
            } else {
              // zip 등은 임시 저장 후 폐기하고 미리보기 폴백
              await download.cancel().catch(() => {});
              log(`[이미지 ${job.index}] 다운로드 형식(${suggested})이 이미지가 아니라 미리보기로 대체`);
            }
          }
          await page.keyboard.press('Escape').catch(() => {});
        } catch (e) {
          log(`[이미지 ${job.index}] 멤버십 다운로드 실패(${e.message.split('\n')[0]}) — 미리보기로 대체`);
          await page.keyboard.press('Escape').catch(() => {});
        }

        // data-preview 이미지 저장.
        // ⚠ 워터마크 판별: 로그인 상태에서는 주소가 previewnw(= no watermark)로 내려오고,
        //   비로그인 상태에서는 preview로 내려오며 "클립아트코리아" 워터마크가 박혀 있다.
        //   워터마크본이 블로그에 그대로 발행된 사고가 있었으므로 previewnw만 사용한다.
        if (!saved && item.preview) {
          if (!/previewnw\./.test(item.preview)) {
            log(`[이미지 ${job.index}] ⚠ 워터마크가 있는 이미지라 건너뜁니다 (로그인 상태를 확인해 주세요)`);
          } else {
            const res = await context.request.get(item.preview);
            if (res.ok()) {
              const buf = await res.body();
              if (buf.length > 5000) {
                fs.writeFileSync(job.filePath, buf);
                saved = true;
                log(`[이미지 ${job.index}] ✅ 다운로드 완료 (워터마크 없음)`);
              }
            }
          }
        }
        if (saved) {
          done.push(job.filePath);
          usedCodes.add(item.code); // 다음 글에서 같은 사진이 다시 나오지 않도록 기록
        } else {
          log(`[이미지 ${job.index}] ⚠ 클립아트코리아에서 받지 못함`);
        }
        await page.waitForTimeout(1000);
      } catch (e) {
        log(`[이미지 ${job.index}] ⚠ 오류: ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    saveUsedCodes(usedCodes);
    await browser.close().catch(() => {});
  }
  return done;
}
