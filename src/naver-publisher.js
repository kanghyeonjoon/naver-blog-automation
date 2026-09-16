import fs from 'fs';
import { launchWithSession, isLoginRedirect } from './naver-auth.js';
import { loadConfig } from './config.js';
import { listPreparedImages } from './images.js';
import { markPublished } from './topics.js';

/**
 * 네이버 블로그 스마트에디터 ONE 자동 발행.
 *
 * 전략:
 * - 글쓰기 진입은 GoBlogWrite.naver (blogId 무관하게 내 블로그 글쓰기로 이동)
 * - 에디터가 iframe(mainFrame) 안에 있을 수도, 직접 로드될 수도 있어 런타임에 감지
 * - 입력은 순차 타이핑 + 툴바 버튼 클릭 (클립보드 HTML 붙여넣기는 SE ONE이 재해석해 예측 불가)
 * - 모든 툴바 셀렉터는 후보 배열 순회 (클래스 + 텍스트/aria-label 다중 폴백)
 * - 발행 후 postwrite URL 이탈 + 게시물 URL 패턴으로 성공 검증
 */

const WRITE_URL = 'https://blog.naver.com/GoBlogWrite.naver';

/** 에디터가 있는 frame 찾기 (iframe/직접 로드 모두 대응) */
async function findEditorFrame(page, log) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator('.se-section-documentTitle, .se-component-content').first().count()) {
          return frame;
        }
      } catch { /* frame 전환 중 오류 무시 */ }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('스마트에디터를 찾지 못했습니다. 로그인 세션이 만료되었거나 에디터 로딩에 실패했습니다.');
}

/** 후보 셀렉터 배열을 순회하며 첫 번째로 존재하는 요소 클릭 */
async function clickFirst(frame, selectors, { timeout = 2000 } = {}) {
  for (const sel of selectors) {
    try {
      const el = frame.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout });
        return sel;
      }
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/** 초기 팝업 처리: 이어쓰기 팝업(취소), 도움말 패널(닫기) */
async function dismissPopups(frame, page, log) {
  await page.waitForTimeout(2000);
  // "작성 중인 글이 있습니다" → 취소 (새 글로 시작)
  const cont = await clickFirst(frame, [
    '.se-popup-button-cancel',
    'button:has-text("취소")',
  ]);
  if (cont) log('이어쓰기 팝업 닫음 (새 글로 시작)');
  // 도움말 패널
  const help = await clickFirst(frame, [
    '.se-help-panel-close-button',
    'button[class*="help"][class*="close"]',
  ]);
  if (help) log('도움말 패널 닫음');
  await page.waitForTimeout(500);
}

/** 제목 입력 + 검증 */
async function typeTitle(frame, page, title, log) {
  const titleArea = frame.locator('.se-section-documentTitle').first();
  await titleArea.waitFor({ state: 'visible', timeout: 15000 });
  await titleArea.click();
  await page.waitForTimeout(500);
  await page.keyboard.insertText(title);
  await page.waitForTimeout(800);
  const typed = await titleArea.innerText().catch(() => '');
  if (!typed.includes(title.slice(0, 10))) {
    throw new Error('제목 입력이 에디터에 반영되지 않았습니다.');
  }
  log(`제목 입력됨: "${title}"`);
}

/** 본문 영역으로 커서 이동 (제목에서 Tab 또는 본문 클릭) */
async function focusBody(frame, page) {
  const body = frame.locator('.se-component-content .se-text-paragraph').last();
  try {
    await body.click({ timeout: 5000 });
  } catch {
    // 폴백: 제목에서 Enter로 본문 이동
    await page.keyboard.press('Tab');
  }
  await page.waitForTimeout(500);
}

/**
 * 글자 스타일 토글(굵게/기울임/밑줄/취소선)이 켜져 있으면 전부 해제.
 * 에디터는 마지막 스타일 상태를 기억하므로, 이전 세션에서 토글이 켜진 채 남아 있으면
 * 이후 입력되는 모든 텍스트에 그 서식이 적용된다 (실제로 취소선 사고 발생).
 */
async function resetStyleToggles(frame, page, log) {
  for (const name of ['bold', 'italic', 'underline', 'strikethrough']) {
    try {
      const btn = frame.locator(`button[data-name="${name}"].se-is-selected`).first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(250);
        log(`⚠ 켜져 있던 ${name} 서식을 해제했습니다.`);
      }
    } catch { /* 무시 */ }
  }
}

/** 굵게 토글 (Ctrl+B) */
async function toggleBold(page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('b');
  await page.keyboard.up('Control');
}

/** 최근 입력 영역(마지막 4개 텍스트 컴포넌트)의 텍스트 — 입력 검증용 */
async function recentText(frame) {
  return frame.evaluate(() => {
    const comps = [...document.querySelectorAll('.se-component.se-text')].slice(-4);
    return comps.map((c) => c.innerText || '').join('\n');
  }).catch(() => '');
}

/**
 * 문단 입력 + 검증. 에디터가 입력을 놓쳐 줄이 통째로 사라지는 경우가 있어
 * (실제 발행에서 2줄 누락 발생) 입력 후 각 줄이 반영됐는지 확인하고 누락분을 보완 입력한다.
 */
async function typeParagraphVerified(frame, page, text, log) {
  await typeText(frame, page, text);
  await page.waitForTimeout(300);

  const plain = String(text).replace(/\*\*|@@|%%|==/g, '');
  const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;

  const recent = await recentText(frame);
  const probe = (l) => l.slice(0, Math.min(12, l.length));
  const missing = lines.filter((l) => !recent.includes(probe(l)));
  if (!missing.length) return;

  log(`  ⚠ 입력 누락 ${missing.length}줄 감지 — 보완 입력합니다.`);
  for (const line of missing) {
    await page.keyboard.press('Enter');
    await page.keyboard.insertText(line);
    await page.waitForTimeout(150);
  }
}

/**
 * 줄바꿈 포함 텍스트를 Enter로 나눠 입력.
 * 마크다운 이스케이프(\*, \_ 등)는 그대로 두면 한글 폰트에서 백슬래시가 ₩로 보이므로 제거한다.
 */
async function insertMultiline(page, text) {
  const lines = String(text).replace(/\\([*_~`#\-.])/g, '$1').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Enter');
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
}

/**
 * 여러 줄 문단 입력. 인라인 마커 처리:
 *   **구절**  → 굵게
 *   @@구절@@  → 빨간색 + 굵게 (핵심 문장 강조)
 *   ==구절==  → 형광펜(배경색)
 * 마커 구간이 여러 줄에 걸쳐 있어도 처리된다 (블록 전체 기준 세그먼트 분리 —
 * 줄 단위로 찾으면 여러 줄짜리 마커의 기호가 그대로 노출되는 버그가 있었음).
 */
async function typeText(frame, page, text) {
  const segments = String(text)
    .split(/(\*\*[\s\S]+?\*\*|@@[\s\S]+?@@|%%[\s\S]+?%%|==[\s\S]+?==)/g)
    .filter(Boolean);
  let endedColored = false;
  for (const seg of segments) {
    let m;
    if ((m = seg.match(/^\*\*([\s\S]+)\*\*$/))) {
      await setToggleStyle(frame, page, 'bold', true);
      await insertMultiline(page, m[1]);
      await setToggleStyle(frame, page, 'bold', false);
      endedColored = false;
    } else if ((m = seg.match(/^@@([\s\S]+)@@$/))) {
      const red = await setFontColorRed(frame, page);
      await setToggleStyle(frame, page, 'bold', true);
      await insertMultiline(page, m[1]);
      await setToggleStyle(frame, page, 'bold', false);
      if (red) await resetFontColor(frame, page);
      endedColored = true;
    } else if ((m = seg.match(/^%%([\s\S]+)%%$/))) {
      const blue = await setFontColorBlue(frame, page);
      await setToggleStyle(frame, page, 'bold', true);
      await insertMultiline(page, m[1]);
      await setToggleStyle(frame, page, 'bold', false);
      if (blue) await resetFontColor(frame, page);
      endedColored = true;
    } else if ((m = seg.match(/^==([\s\S]+)==$/))) {
      const hl = await setHighlight(frame, page);
      await insertMultiline(page, m[1]);
      if (hl) await resetHighlight(frame, page);
      endedColored = true;
    } else {
      // 짝이 안 맞는 잔여 마커는 제거하고 입력
      await insertMultiline(page, seg.replace(/\*\*|@@|%%|==/g, ''));
      endedColored = false;
    }
  }
  // 팔레트로 바꾼 "타이핑 색 상태"는 커서가 이동하면 증발하고 앞 글자의 색을 다시 물려받는다.
  // 블록이 색 구절로 끝나면, 리셋 직후 기본색 공백 문자를 실제로 입력해 리셋을 글자로 박아둔다
  // (이게 없으면 다음 이미지/소제목 클릭 이후 모든 텍스트가 그 색을 상속받는 사고 발생).
  if (endedColored) {
    await page.keyboard.insertText(' ');
  }
}

/** 현재 커서 줄의 텍스트를 전체 선택 (서식 적용용) */
async function selectCurrentLine(page) {
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
}

// 소제목은 원본 원고처럼 "본문보다 살짝 크고 굵게 + 아래 구분선" (과하게 크지 않게)
const HEADING_FONT_SIZE = 'fs16';
const BODY_FONT_SIZE = 'fs15';

/** 폰트 크기 지정 (fs19 = 소제목, fs15 = 본문). 드롭다운이 늦게 뜨므로 재시도 */
async function setFontSize(frame, page, value) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickFirst(frame, ['.se-font-size-code-toolbar-button', 'button[data-name="font-size"]']);
    const opt = frame.locator(`button[data-value="${value}"], .se-toolbar-option-font-size-code-${value}-button`).first();
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(250);
      if (await opt.isVisible().catch(() => false)) {
        try { await opt.click({ timeout: 2000 }); return true; } catch { /* 재시도 */ }
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return false;
}

/**
 * 소제목: 한 소제목이 여러 줄이어도 줄 사이에 빈 줄 없이 붙여 하나의 덩어리로 보이게 한다.
 * 각 줄마다 (입력 → 줄 선택 → 크기24+굵게) 를 적용한다 — 타이핑 상태로만 켜두면
 * 줄바꿈에서 서식이 풀리는 경우가 있어 "입력 후 선택 적용"이 확실하다.
 */
// 소제목용 인용구 스타일 (에디터 드롭다운의 "인용구 4/6"에 해당)
const QUOTATION_STYLE = { corner: 'quotation_corner', underline: 'quotation_underline' };

/**
 * 인용구 컴포넌트에서 빠져나온다.
 * 인용구 바로 "아래" 좌표를 클릭하는 방식 — 커서(selection) 판정으로 탈출을 확인하는 방식은
 * 오판이 잦아 문단이 인용구에 삼켜지는 사고가 반복됐다 (실험으로 이 방식만 안정적임을 확인).
 */
async function escapeQuotation(frame, page) {
  const q = frame.locator('.se-component.se-quotation').last();
  const box = await q.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height + 18);
    await page.waitForTimeout(600);
    return true;
  }
  // 폴백: 본문 영역 하단 빈 공간 클릭
  const cont = await frame.locator('.se-container, .se-content, .se-canvas').first().boundingBox().catch(() => null);
  if (cont) {
    await page.mouse.click(cont.x + cont.width / 2, cont.y + cont.height - 15);
    await page.waitForTimeout(600);
    return true;
  }
  return false;
}

/**
 * 환자 사례 박스([CASE]): 원고의 도입부 회색 박스.
 * 네이버 인용구(모서리 박스)로 만들고, 여러 줄을 그대로 담는다.
 */
async function typeCaseBox(frame, page, text, log) {
  const lines = String(text).split('\n').map((l) => l.replace(/\*\*|@@|%%|==/g, '').trimEnd());

  const opened = await clickFirst(frame, [
    'button[data-name="quotation"].se-document-toolbar-select-option-button',
    '.se-document-toolbar-select-option-button',
  ]);
  let inBox = false;
  if (opened) {
    await page.waitForTimeout(600);
    inBox = !!(await clickFirst(frame, ['button[data-value="quotation_corner"]']));
    if (!inBox) await page.keyboard.press('Escape').catch(() => {});
  }
  if (!inBox) log('  ⚠ 사례 박스를 만들지 못해 일반 문단으로 넣습니다.');
  await page.waitForTimeout(600);

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Enter');
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
  await page.waitForTimeout(300);

  if (inBox && !(await escapeQuotation(frame, page))) {
    log('  ⚠ 사례 박스에서 빠져나오지 못했습니다.');
  }
}

async function typeHeading(frame, page, text, log) {
  // 소제목은 항상 한 줄. 그리고 "서식을 먼저 켜고 입력"한다 —
  // 입력 후 Home/Shift+End로 선택해 적용하는 방식은 소제목이 통째로 사라지는 사고가 반복됐다.
  const line = String(text).replace(/\*\*|@@|%%|==/g, '').replace(/\s*\n\s*/g, ' ').trim();
  if (!line) return;

  const style = loadConfig().headingStyle || 'corner';
  const quotStyle = QUOTATION_STYLE[style];

  // ① 인용구 박스형 소제목 (모서리 박스 / 밑줄)
  if (quotStyle) {
    const opened = await clickFirst(frame, [
      'button[data-name="quotation"].se-document-toolbar-select-option-button',
      '.se-document-toolbar-select-option-button',
    ]);
    if (opened) {
      await page.waitForTimeout(600);
      const picked = await clickFirst(frame, [`button[data-value="${quotStyle}"]`]);
      if (picked) {
        await page.waitForTimeout(700);
        await page.keyboard.insertText(line);
        await page.waitForTimeout(300);
        if (!(await escapeQuotation(frame, page))) {
          log('  ⚠ 인용구에서 빠져나오지 못했습니다 — 이후 본문이 상자 안에 들어갈 수 있습니다.');
        }
        return;
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
    log('  ⚠ 인용구 소제목 삽입 실패 — 가운데 텍스트로 대체');
  }

  // ② 가운데 정렬 텍스트 + 아래 구분선
  const centered = await setAlign(frame, page, 'center', log);
  const sized = await setFontSize(frame, page, HEADING_FONT_SIZE);
  await setToggleStyle(frame, page, 'bold', true);
  if (!sized) log('  ⚠ 소제목 크기 변경 실패 — 굵게만 적용');

  await page.keyboard.insertText(line);
  await page.waitForTimeout(200);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await setToggleStyle(frame, page, 'bold', false);
  await setFontSize(frame, page, BODY_FONT_SIZE);
  if (centered) await setAlign(frame, page, 'left', log);
  // 소제목 아래 선은 원고처럼 전체 폭 얇은 선(line1)
  await insertDivider(frame, page, log, 'line1');

  // 구분선을 넣으면 커서가 새 문단으로 옮겨가면서 소제목의 굵기/크기를 다시 상속받는다
  // (색 번짐과 같은 원리) → 여기서 한 번 더 끄고, 기본 서식 공백 한 칸으로 박아둔다.
  await setToggleStyle(frame, page, 'bold', false);
  await setFontSize(frame, page, BODY_FONT_SIZE);
  await page.keyboard.insertText(' ');
}

/** 정렬 설정: 정렬 드롭다운 → left|center|right (드롭다운이 열릴 때까지 재시도) */
async function setAlign(frame, page, value, log) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickFirst(frame, ['button[data-name="align-drop-down-with-justify"]']);
    // 옵션이 실제로 보일 때까지 대기
    const opt = frame.locator(`button[data-name="align-drop-down-with-justify"][data-value="${value}"]`).first();
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(250);
      if (await opt.isVisible().catch(() => false)) {
        try {
          await opt.click({ timeout: 2000 });
          return true;
        } catch { /* 재시도 */ }
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  log(`  ⚠ 정렬(${value}) 적용 실패`);
  return false;
}

/** 색상 팔레트 열기 (열릴 때까지 재시도) — dataName: font-color | background-color */
async function openPalette(frame, page, dataName) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickFirst(frame, [`button[data-name="${dataName}"]`]);
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(250);
      const visible = await frame.locator('button.se-color-palette').first().isVisible().catch(() => false);
      if (visible) return true;
    }
  }
  return false;
}

/**
 * 팔레트에서 색 선택. kind: 'red' | 'yellow' | 'none'(초기화).
 * 성공 여부를 반드시 반환 — 해제 실패를 무시하면 이후 글 전체에 색이 번지는 사고가 남.
 */
async function pickPaletteColor(frame, page, dataName, kind) {
  if (!(await openPalette(frame, page, dataName))) return false;
  let clicked = false;
  // 'none'(색상 없음)은 커서 타이핑 상태에 적용되지 않는 경우가 있어 쓰지 않는다 —
  // 초기화도 실제 색(검정/흰색) 스와치를 클릭한다 (색을 켠 것과 같은 메커니즘이라 확실함).
  const handle = await frame.evaluateHandle((k) => {
    const parse = (h) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    };
    const btns = [...document.querySelectorAll('button.se-color-palette')]
      .filter((b) => !!(b.offsetWidth || b.offsetHeight));
    // 네이버 71색 팔레트에서 실제로 쓸 색 (정확 hex 우선 — 근사 조건만 쓰면 옅은 색이 먼저 잡힘)
    const EXACT = { red: '#ff0010', blue: '#0078cb', yellow: '#fff8b2', black: '#141414', white: '#ffffff' };
    const exact = btns.find((b) => (b.getAttribute('data-color') || '').toLowerCase() === EXACT[k]);
    if (exact) return exact;
    const match = (c) => {
      if (k === 'red') return c.r > 180 && c.g < 90 && c.b < 90;
      if (k === 'blue') return c.b > 150 && c.r < 80 && c.g < 170 && c.b - c.r > 100;
      if (k === 'yellow') return c.r > 235 && c.g > 215 && c.b < 200;
      if (k === 'black') return c.r < 45 && c.g < 45 && c.b < 45;
      if (k === 'white') return c.r > 245 && c.g > 245 && c.b > 245;
      return false;
    };
    return btns.find((b) => { const c = parse(b.getAttribute('data-color')); return c && match(c); }) || null;
  }, kind).catch(() => null);
  const el = handle && handle.asElement();
  if (el) {
    await el.click({ timeout: 3000 }).catch(() => {});
    clicked = true;
  } else if (kind === 'black' || kind === 'white') {
    // 검정/흰색 스와치가 없으면 색상 없음으로 폴백
    clicked = !!(await clickFirst(frame, ['button.se-color-palette-no-color']));
  }
  if (!clicked) await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return clicked;
}

/** 토글 서식(bold/italic 등)을 원하는 상태로 — 툴바 버튼의 se-is-selected로 실제 상태 검증 */
async function setToggleStyle(frame, page, name, on) {
  for (let i = 0; i < 3; i++) {
    const btn = frame.locator(`button[data-name="${name}"]`).first();
    const selected = await btn.evaluate((el) => el.classList.contains('se-is-selected')).catch(() => null);
    if (selected === null) return false;
    if (selected === on) return true;
    await btn.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  return false;
}

// 색 상태 추적: 해제 실패 시 dirty로 표시해 두고 다음 입력 전에 재시도 (자가 치유)
const styleState = { colorDirty: false, highlightDirty: false };

async function setFontColorRed(frame, page) {
  return pickPaletteColor(frame, page, 'font-color', 'red');
}
async function setFontColorBlue(frame, page) {
  return pickPaletteColor(frame, page, 'font-color', 'blue');
}
async function resetFontColor(frame, page) {
  for (let i = 0; i < 3; i++) {
    if (await pickPaletteColor(frame, page, 'font-color', 'black')) {
      styleState.colorDirty = false;
      return true;
    }
  }
  styleState.colorDirty = true;
  return false;
}
async function setHighlight(frame, page) {
  return pickPaletteColor(frame, page, 'background-color', 'yellow');
}
async function resetHighlight(frame, page) {
  for (let i = 0; i < 3; i++) {
    if (await pickPaletteColor(frame, page, 'background-color', 'white')) {
      styleState.highlightDirty = false;
      return true;
    }
  }
  styleState.highlightDirty = true;
  return false;
}

/** 이전 블록에서 서식(색·형광펜·굵게)이 켜진 채 넘어왔으면 입력 전에 해제 */
async function healStyleState(frame, page, log) {
  if (styleState.colorDirty) {
    log('  ⚠ 글자색 해제 재시도...');
    await resetFontColor(frame, page);
  }
  if (styleState.highlightDirty) {
    log('  ⚠ 형광펜 해제 재시도...');
    await resetHighlight(frame, page);
  }
  // 소제목에서 넘어온 굵기가 남아 문단 전체가 굵어지는 사고 방지
  const boldOn = await frame.locator('button[data-name="bold"]').first()
    .evaluate((el) => el.classList.contains('se-is-selected')).catch(() => false);
  if (boldOn) {
    log('  ⚠ 굵게가 켜져 있어 해제합니다.');
    await setToggleStyle(frame, page, 'bold', false);
  }
}

/**
 * 전환 문구([QUOTE]): "가운데 정렬 + 기울임" 텍스트 (따옴표 질문, 섹션 전환 문구).
 * 빨간색은 여기 쓰지 않는다 — 빨강은 본문 인라인 @@...@@ 핵심 강조 전용 (사용자 지시).
 * (네이버 인용구 컴포넌트는 탈출 버그가 반복되어 사용하지 않는다 — 일반 문단이라 안전함)
 */
async function typeQuote(frame, page, text, log) {
  const centered = await setAlign(frame, page, 'center', log);
  await setToggleStyle(frame, page, 'italic', true);

  await typeText(frame, page, text);

  // 다음 문단으로 이동 후 스타일 원복 (토글 상태를 검증하며 해제 — Ctrl+I는 포커스 유실 시 무시됨)
  await page.keyboard.press('Enter');
  await setToggleStyle(frame, page, 'italic', false);
  if (centered) await setAlign(frame, page, 'left', log);
}

/**
 * 구분선 삽입.
 * @param style 'default'(짧은 선, [HR]용) | 'line1'(전체 폭 얇은 선, 소제목 아래용)
 */
async function insertDivider(frame, page, log, style = 'default') {
  if (style !== 'default') {
    // 스타일 지정: "구분선 선택" 드롭다운을 열어 해당 스타일 클릭
    const opened = await clickFirst(frame, [
      'button[data-name="horizontal-line"].se-document-toolbar-select-option-button',
    ]);
    if (opened) {
      await page.waitForTimeout(600);
      const picked = await clickFirst(frame, [`button[data-value="${style}"]`]);
      if (picked) { await page.waitForTimeout(600); return; }
      await page.keyboard.press('Escape').catch(() => {});
    }
    // 실패 시 기본 구분선으로 폴백
  }
  const btn = await clickFirst(frame, [
    '.se-insert-horizontal-line-default-toolbar-button',
    'button[data-name="horizontal-line"][data-value="default"]',
  ]);
  if (!btn) {
    log('  ⚠ 구분선 버튼을 찾지 못해 빈 줄로 대체');
    await page.keyboard.press('Enter');
    return;
  }
  await page.waitForTimeout(600);
}

/** 이미지 업로드: 사진 버튼 → filechooser → 업로드 완료 폴링 */
async function insertImage(frame, page, filePath, log) {
  if (!filePath || !fs.existsSync(filePath)) {
    log('  ⚠ 이미지 파일이 없어 건너뜁니다.');
    return false;
  }
  const before = await frame.locator('.se-component.se-image').count();

  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  const btn = await clickFirst(frame, [
    '.se-image-toolbar-button',
    'button[data-name="image"]',
    'button[aria-label*="사진"]',
  ]);
  if (!btn) {
    log('  ⚠ 사진 버튼을 찾지 못해 이미지를 건너뜁니다.');
    return false;
  }
  let chooser;
  try {
    chooser = await chooserPromise;
  } catch {
    log('  ⚠ 파일 선택 창이 열리지 않아 이미지를 건너뜁니다.');
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await chooser.setFiles(filePath);

  // 업로드 완료 대기: se-image 컴포넌트 개수 증가 폴링 (최대 20초)
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const now = await frame.locator('.se-component.se-image').count();
    if (now > before) {
      await page.waitForTimeout(1500); // 렌더 안정화
      // 커서를 문서 끝(이미지 아래)으로 복귀
      const last = frame.locator('.se-component-content .se-text-paragraph').last();
      await last.click({ timeout: 3000 }).catch(() => {});
      await page.keyboard.press('Control+End').catch(() => {});
      return true;
    }
    await page.waitForTimeout(1000);
  }
  log('  ⚠ 이미지 업로드 확인 실패 (20초 초과) — 계속 진행합니다.');
  return false;
}

// 공개 설정 → 발행 레이어 라디오 버튼 id (에디터 DOM 진단으로 확인됨)
const VISIBILITY_RADIO = {
  '전체공개': 'open_public',
  '이웃공개': 'open_neighbor',
  '서로이웃공개': 'open_both_neighbor',
  '비공개': 'open_private',
};

/** 발행 레이어에서 태그·카테고리·공개설정 후 최종 발행 */
async function publishWithSettings(frame, page, { tags, category, visibility }, log) {
  // 헤더의 "발행" 버튼 (frame 안, class에 publish_btn 포함 — reserve_btn과 혼동 금지)
  const opened = await clickFirst(frame, [
    'button[class*="publish_btn"]',
    'button[data-click-area*="publish"]',
  ], { timeout: 5000 });
  if (!opened) throw new Error('상단 발행 버튼을 찾지 못했습니다.');

  // 레이어가 열렸는지 태그 입력창으로 확인
  const tagInput = frame.locator('#tag-input, input[placeholder*="태그"]').first();
  try {
    await tagInput.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    throw new Error('발행 설정 레이어가 열리지 않았습니다.');
  }
  log('발행 설정 레이어 열림');
  await page.waitForTimeout(800);

  // 카테고리 설정 (설정된 경우만, 실패해도 계속)
  // 발행 레이어의 카테고리는 커스텀 셀렉트박스: [class*="option_category"] > button[class*="selectbox_button"]
  // → 목록은 li[class*="item"] > label[class*="radio_label"] (이름 정확 일치로 골라야 함)
  if (category) {
    try {
      const catBtn = await clickFirst(frame, [
        '[class*="option_category"] button[class*="selectbox_button"]',
        'button[class*="selectbox_button"]',
      ]);
      if (!catBtn) {
        log('⚠ 카테고리 선택 버튼을 찾지 못해 기본 카테고리로 발행');
      } else {
        await page.waitForTimeout(800);
        const handle = await frame.evaluateHandle((name) => {
          const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
          const labels = [...document.querySelectorAll('label[class*="radio_label"]')].filter(vis);
          return labels.find((l) => (l.innerText || '').trim() === name)
            || labels.find((l) => (l.innerText || '').trim().replace(/\s+/g, '') === name.replace(/\s+/g, ''))
            || null;
        }, category).catch(() => null);
        const el = handle && handle.asElement();
        if (el) {
          await el.click({ timeout: 3000 });
          await page.waitForTimeout(500);
          log(`카테고리 선택됨: ${category}`);
        } else {
          const names = await frame.evaluate(() =>
            [...document.querySelectorAll('label[class*="radio_label"]')]
              .filter((e) => !!(e.offsetWidth || e.offsetHeight))
              .map((e) => (e.innerText || '').trim())
              .filter(Boolean)
          ).catch(() => []);
          log(`⚠ 카테고리 "${category}"를 찾지 못했습니다. 사용 가능: ${names.join(' / ')}`);
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    } catch (e) { log(`⚠ 카테고리 설정 실패(${e.message.split('\n')[0]}) — 기본값으로 발행`); }
  }

  // 태그 입력
  if (tags && tags.length) {
    try {
      await tagInput.click();
      for (const tag of tags.slice(0, 10)) {
        await page.keyboard.insertText(tag.replace(/^#/, '').replace(/\s+/g, ''));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(250);
      }
      log(`태그 ${Math.min(tags.length, 10)}개 입력됨`);
    } catch (e) { log(`⚠ 태그 입력 실패: ${e.message}`); }
  }

  // 공개 설정 (라디오 id 기반)
  const radioId = VISIBILITY_RADIO[visibility];
  if (radioId) {
    try {
      const label = frame.locator(`label[for="${radioId}"]`).first();
      if (await label.count()) {
        await label.click();
        log(`공개 설정: ${visibility}`);
      } else {
        log(`⚠ 공개 설정 "${visibility}" 라디오를 찾지 못해 기본값으로 발행`);
      }
    } catch { log('⚠ 공개 설정 실패 — 기본값으로 발행'); }
  }

  await page.waitForTimeout(700);

  // 레이어 내부의 최종 "발행" 버튼 — element handle로 클릭 (좌표 클릭은 iframe 오프셋 때문에
  // 엉뚱한 버튼(예: 취소선)을 누르는 사고가 있었음 — 절대 좌표 클릭 금지)
  const clicked = await clickFinalPublish(frame);
  if (!clicked) throw new Error('발행 설정 레이어에서 최종 발행 버튼을 찾지 못했습니다.');
  log('최종 발행 버튼 클릭');
}

/**
 * 텍스트가 정확히 "발행"인 확인 버튼을 element handle로 클릭.
 * 헤더 발행 버튼(publish_btn)·예약 버튼(reserve_btn)은 제외하고 레이어 내부 확인 버튼만 대상.
 */
async function clickFinalPublish(frame) {
  const handle = await frame.evaluateHandle(() => {
    const candidates = [...document.querySelectorAll('button')]
      .filter((b) => !!(b.offsetWidth || b.offsetHeight))
      .filter((b) => (b.innerText || '').trim() === '발행')
      .filter((b) => !/publish_btn|reserve_btn/.test(b.className));
    // confirm 계열 클래스 우선, 없으면 마지막 후보
    return candidates.find((b) => /confirm/i.test(b.className)) || candidates[candidates.length - 1] || null;
  }).catch(() => null);
  const btn = handle && handle.asElement();
  if (!btn) return false;
  await btn.click({ timeout: 5000 });
  return true;
}

/**
 * 초안({meta, blocks} + 준비된 이미지)을 네이버 블로그에 발행한다.
 * @returns {Promise<{url: string|null}>}
 */
export async function publishPost({ draftName, parsed, sourceUrls = [], log }) {
  const { meta, blocks } = parsed;
  const config = loadConfig();
  const images = listPreparedImages(draftName);
  const imageByIndex = new Map(images.map((im) => [im.index, im.file]));

  log('브라우저 실행 중...');
  const { browser, context } = await launchWithSession();
  try {
    const page = await context.newPage();
    log('글쓰기 페이지로 이동...');
    await page.goto(WRITE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    if (isLoginRedirect(page.url())) {
      throw new Error('세션이 만료되었습니다. 네이버 로그인을 다시 실행해 주세요.');
    }

    const frame = await findEditorFrame(page, log);
    log('에디터 감지 완료');
    await dismissPopups(frame, page, log);

    // ---------- 제목 ----------
    await typeTitle(frame, page, meta.title, log);

    // ---------- 본문 블록 ----------
    await focusBody(frame, page);
    await resetStyleToggles(frame, page, log);
    log(`본문 입력 시작 (블록 ${blocks.length}개)...`);
    styleState.colorDirty = false;
    styleState.highlightDirty = false;
    let skippedImages = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const isLast = i === blocks.length - 1;
      try {
        await healStyleState(frame, page, log);
        if (b.type === 'heading') {
          log(`[${i + 1}/${blocks.length}] 소제목: ${b.text.replace(/\n/g, ' / ').slice(0, 40)}`);
          await typeHeading(frame, page, b.text, log);
        } else if (b.type === 'case') {
          log(`[${i + 1}/${blocks.length}] 환자 사례 박스`);
          await typeCaseBox(frame, page, b.text, log);
        } else if (b.type === 'quote') {
          log(`[${i + 1}/${blocks.length}] 강조 문구 (기울임·가운데)`);
          await typeQuote(frame, page, b.text, log);
        } else if (b.type === 'divider') {
          log(`[${i + 1}/${blocks.length}] 구분선`);
          await insertDivider(frame, page, log);
        } else if (b.type === 'image') {
          log(`[${i + 1}/${blocks.length}] 이미지 ${b.imageIndex} 업로드...`);
          const ok = await insertImage(frame, page, imageByIndex.get(b.imageIndex), log);
          if (!ok) skippedImages++;
        } else {
          log(`[${i + 1}/${blocks.length}] 문단`);
          await typeParagraphVerified(frame, page, b.text, log);
        }

        // ---------- 블록 간 간격 (일정한 리듬 유지) ----------
        // 실제 원고처럼 문단 사이를 넉넉히 띄운다: 기본 빈 줄 2개, 소제목 앞은 3개.
        // heading/quote는 내부에서 이미 새 줄로 나와 있고, image/divider는 컴포넌트 뒤에
        // 빈 문단이 자동 생성되므로 "줄 마무리 Enter"가 필요한 건 문단뿐이다.
        if (!isLast) {
          const nextType = blocks[i + 1].type;
          const gap = nextType === 'heading' ? 3 : 2;
          if (b.type === 'para' || b.type === 'case') await page.keyboard.press('Enter');
          for (let k = 0; k < gap; k++) await page.keyboard.press('Enter');
        }
        await page.waitForTimeout(400);
      } catch (e) {
        log(`⚠ 블록 ${i + 1}(${b.type}) 입력 실패: ${e.message} — 다음 블록 진행`);
      }
    }
    if (skippedImages) log(`⚠ 이미지 ${skippedImages}개가 생략되었습니다.`);

    // ---------- 발행 ----------
    log('발행 진행...');
    await publishWithSettings(frame, page, {
      tags: meta.tags,
      category: config.category,
      visibility: config.visibility,
    }, log);

    // ---------- 검증: 게시물 URL로 이동했는지 ----------
    // 발행이 완료되면 blog.naver.com/{id}/{글번호} 또는 PostView.naver 로 이동한다.
    // 에디터 URL(?Redirect=Write 등)에 머물러 있으면 발행 실패로 판정한다 (과거 오판 사고 방지).
    let finalUrl = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const url = page.url();
      if (/blog\.naver\.com\/[^/?]+\/\d+/.test(url) || /PostView\.naver/.test(url)) {
        finalUrl = url;
        break;
      }
      await page.waitForTimeout(1500);
    }
    if (!finalUrl) {
      throw new Error(
        `발행 버튼은 눌렀지만 게시물 페이지로 이동하지 않았습니다 (현재: ${page.url()}). ` +
          '발행이 완료되지 않은 것으로 판단됩니다. 에디터에 임시저장된 글이 남아있을 수 있습니다.'
      );
    }
    log(`✅ 발행 완료: ${finalUrl}`);

    // 중복 방지 기록
    markPublished({ title: meta.title, sourceUrls });

    return { url: finalUrl };
  } finally {
    await browser.close().catch(() => {});
  }
}
