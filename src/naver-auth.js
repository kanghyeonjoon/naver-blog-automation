import { chromium } from 'playwright';
import fs from 'fs';
import { SESSION_FILE, AUTH_DIR } from './files.js';

const LOGIN_URL = 'https://nid.naver.com/nidlogin.login?mode=form&url=https://blog.naver.com';

/**
 * 로그인 세션 저장:
 * 브라우저를 띄워 사용자가 직접 네이버에 로그인하게 하고,
 * 로그인 완료(NID_AUT + NID_SES 쿠키 감지)되면 storageState를 로컬에 저장한다.
 * ID/비밀번호는 절대 프로그램이 다루지 않는다 — 사용자가 브라우저에서 직접 입력.
 */
export async function saveLoginSession(log) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  log('브라우저를 실행합니다. 열린 창에서 네이버에 로그인해 주세요.');
  log('(2단계 인증·기기 등록도 브라우저에서 그대로 진행하면 됩니다)');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: 'ko-KR' });
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  log('로그인 대기 중... (최대 5분)');
  const deadline = Date.now() + 5 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    const cookies = await context.cookies();
    const hasAut = cookies.some((c) => c.name === 'NID_AUT' && c.value);
    const hasSes = cookies.some((c) => c.name === 'NID_SES' && c.value);
    if (hasAut && hasSes) {
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!loggedIn) {
    await browser.close().catch(() => {});
    throw new Error('로그인이 감지되지 않았습니다. 다시 시도해 주세요.');
  }

  // 로그인 직후 쿠키가 안정화되도록 잠시 대기
  await page.waitForTimeout(3000);
  await context.storageState({ path: SESSION_FILE });
  await browser.close();
  log('네이버 로그인 세션이 저장되었습니다.');
  return true;
}

/**
 * 저장된 세션으로 브라우저 실행 (크롤러·발행 공용).
 * required=false면 세션이 없어도 새 컨텍스트로 실행 (검색·수집은 로그인 없이도 가능).
 */
export async function launchWithSession({ required = true } = {}) {
  const hasSession = fs.existsSync(SESSION_FILE);
  if (!hasSession && required) {
    throw new Error('저장된 로그인 세션이 없습니다. 먼저 "네이버 로그인"을 실행해 주세요.');
  }
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    ...(hasSession ? { storageState: SESSION_FILE } : {}),
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });
  return { browser, context };
}

/** 페이지가 로그인 화면으로 밀려났는지 감지 */
export function isLoginRedirect(url) {
  return /nid\.naver\.com|nidlogin/.test(url);
}

/**
 * 네이버 로그인 세션이 아직 유효한지 빠르게 확인 (약 10초).
 * 발행 직전에야 만료를 알게 되면 그때까지의 작업(이미지 준비 등)이 헛수고가 되므로,
 * 오래 걸리는 작업을 시작하기 전에 먼저 확인하는 용도.
 */
export async function checkNaverSession() {
  if (!fs.existsSync(SESSION_FILE)) return { ok: false, reason: '저장된 네이버 로그인 세션이 없습니다.' };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: SESSION_FILE, locale: 'ko-KR' });
    const page = await context.newPage();
    await page.goto('https://blog.naver.com/GoBlogWrite.naver', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    if (isLoginRedirect(page.url())) {
      return { ok: false, reason: '네이버 로그인 세션이 만료되었습니다. 우측 상단 "네이버 로그인"을 다시 실행해 주세요.' };
    }
    return { ok: true };
  } catch (e) {
    // 확인 자체가 실패하면 막지 않는다 (네트워크 일시 오류로 작업을 못 하게 되면 곤란)
    return { ok: true, warn: `세션 확인 실패: ${e.message.split('\n')[0]}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** 요청 간 랜덤 대기 (봇 탐지 완화) */
export function randomWait(page, minMs = 1500, maxMs = 3000) {
  return page.waitForTimeout(minMs + Math.floor(Math.random() * (maxMs - minMs)));
}
