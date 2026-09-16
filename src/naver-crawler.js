import { launchWithSession, isLoginRedirect, randomWait } from './naver-auth.js';
import { isUsedUrl } from './topics.js';
import { getSearchTrend, trendToMarkdown } from './datalab.js';

/**
 * 네이버 크롤링 전략:
 * - 검색·본문 모두 모바일 도메인(m.search.naver.com / m.blog.naver.com)을 사용한다.
 *   PC 검색은 클래스명이 난독화되어 수시로 바뀌고, PC 블로그 본문은 iframe(#mainFrame) 안에 있어
 *   모바일이 구조가 단순하고 안정적이다.
 * - 뉴스 본문은 n.news.naver.com 기사만 수집 (#dic_area — 수년째 안정적인 셀렉터).
 *   외부 언론사 사이트 링크는 제목+요약만 사용.
 */

const NEWS_SEARCH = (kw) => `https://m.search.naver.com/search.naver?where=m_news&sort=1&query=${encodeURIComponent(kw)}`;
const BLOG_SEARCH = (kw) => `https://m.search.naver.com/search.naver?where=m_blog&query=${encodeURIComponent(kw)}`;

/** 검색결과 페이지에서 링크 후보 수집 (브라우저 컨텍스트에서 실행) */
const COLLECT_LINKS_FN = (opts) => {
  const { hrefPattern } = opts;
  const re = new RegExp(hrefPattern);
  const seen = new Set();
  const results = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!re.test(href)) continue;
    // 링크가 속한 카드(컨테이너)를 찾아 제목/요약 추출 — 클래스명 의존 최소화 휴리스틱
    let container = a;
    for (let i = 0; i < 6 && container.parentElement; i++) {
      container = container.parentElement;
      if ((container.innerText || '').length > 30) break;
    }
    const text = (container.innerText || '').trim();
    if (!text) continue;
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 1);
    // 가장 긴 라인을 제목 후보로, 그 다음 긴 라인을 요약 후보로
    const sorted = [...lines].sort((x, y) => y.length - x.length);
    const title = (a.innerText || '').trim().split('\n')[0] || sorted[0] || '';
    const summary = sorted.find((l) => l !== title && l.length > 20) || '';
    const key = href.split('?')[0];
    if (seen.has(key) || title.length < 5) continue;
    seen.add(key);
    results.push({ url: href, title: title.slice(0, 120), summary: summary.slice(0, 300) });
  }
  return results;
};

/** 블로그 URL을 모바일 본문 URL로 정규화 (iframe 우회) */
export function normalizeBlogUrl(url) {
  try {
    const u = new URL(url);
    if (!/blog\.naver\.com/.test(u.hostname)) return null;
    // PostView.naver?blogId=..&logNo=.. 형태
    const blogId = u.searchParams.get('blogId');
    const logNo = u.searchParams.get('logNo');
    if (blogId && logNo) return `https://m.blog.naver.com/${blogId}/${logNo}`;
    // /{blogId}/{logNo} 형태
    const m = u.pathname.match(/^\/([\w.-]+)\/(\d+)/);
    if (m) return `https://m.blog.naver.com/${m[1]}/${m[2]}`;
    return null;
  } catch {
    return null;
  }
}

/** 블로그 본문 추출 — 에디터 세대별 다단 폴백 (브라우저 컨텍스트에서 실행) */
const BLOG_BODY_FN = () => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.innerText || '').trim() : '';
  };
  // 스마트에디터 ONE → 구 에디터 → 모바일 구버전 순
  let body = pick('.se-main-container') || pick('#postViewArea') || pick('.post_ct') || pick('#viewTypeSelector');
  if (!body) {
    // 최후: body에서 가장 긴 텍스트 블록
    let longest = '';
    for (const el of document.querySelectorAll('div, article, section')) {
      const t = (el.innerText || '').trim();
      if (t.length > longest.length && el.querySelectorAll('div').length < 50) longest = t;
    }
    body = longest;
  }
  const title = pick('.se-title-text') || pick('.tit_h3') || pick('h3.se_textarea') || document.title;
  return { title: title.slice(0, 150), body };
};

/** 네이버 뉴스 본문 추출 */
const NEWS_BODY_FN = () => {
  const el = document.querySelector('#dic_area') || document.querySelector('#newsct_article');
  const titleEl = document.querySelector('h2#title_area, .media_end_head_headline, h2.media_end_head_headline');
  return {
    title: titleEl ? titleEl.innerText.trim() : document.title,
    body: el ? el.innerText.trim() : '',
  };
};

async function collectSearchLinks(page, url, hrefPattern, maxScrolls, log) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await randomWait(page);
  if (isLoginRedirect(page.url())) {
    throw new Error('세션이 만료되었습니다. 네이버 로그인을 다시 실행해 주세요.');
  }
  const found = new Map();
  for (let i = 0; i < maxScrolls; i++) {
    const items = await page.evaluate(COLLECT_LINKS_FN, { hrefPattern });
    for (const it of items) {
      const key = it.url.split('?')[0];
      if (!found.has(key)) found.set(key, it);
    }
    log(`  스크롤 ${i + 1}/${maxScrolls} — 후보 ${found.size}개`);
    await page.mouse.wheel(0, 2500);
    await randomWait(page, 1200, 2200);
  }
  return [...found.values()];
}

/**
 * 키워드로 뉴스 + 인기 블로그 글을 수집한다.
 * @returns {Promise<{news: [], blogs: []}>}
 */
export async function crawl({ keyword, sources = ['news', 'blog'], maxItems = 5, log }) {
  // 수집은 로그인 없이도 가능 (세션이 있으면 재사용)
  const { browser, context } = await launchWithSession({ required: false });
  const result = { news: [], blogs: [], stats: [], trend: null };
  try {
    const page = await context.newPage();

    // ---------- 1) 뉴스 ----------
    if (sources.includes('news')) {
      log(`[뉴스] 검색: "${keyword}"`);
      const candidates = await collectSearchLinks(
        page, NEWS_SEARCH(keyword), 'news\\.naver\\.com|n\\.news\\.naver\\.com', 3, log
      );
      const targets = candidates.filter((c) => /n\.news\.naver\.com/.test(c.url)).slice(0, maxItems);
      log(`[뉴스] 네이버뉴스 기사 ${targets.length}개 본문 수집 시작`);
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        try {
          await page.goto(t.url, { waitUntil: 'domcontentloaded' });
          await randomWait(page);
          const detail = await page.evaluate(NEWS_BODY_FN);
          result.news.push({
            url: t.url.split('?')[0],
            title: detail.title || t.title,
            body: (detail.body || t.summary || '').slice(0, 2000),
          });
          log(`  [${i + 1}/${targets.length}] ${detail.title || t.title}`);
        } catch (e) {
          log(`  ⚠ [${i + 1}] 수집 실패: ${e.message}`);
        }
      }
      // 본문을 못 가져온 경우에도 제목+요약만이라도 확보
      if (!result.news.length && candidates.length) {
        result.news = candidates.slice(0, maxItems).map((c) => ({
          url: c.url.split('?')[0], title: c.title, body: c.summary,
        }));
        log(`[뉴스] 본문 수집 실패 — 제목/요약 ${result.news.length}개로 대체`);
      }
    }

    // ---------- 2) 블로그 ----------
    if (sources.includes('blog')) {
      log(`[블로그] 검색: "${keyword}"`);
      const candidates = await collectSearchLinks(
        page, BLOG_SEARCH(keyword), 'blog\\.naver\\.com', 3, log
      );
      const targets = [];
      for (const c of candidates) {
        const mobile = normalizeBlogUrl(c.url);
        if (!mobile) continue;
        if (isUsedUrl(mobile)) { log(`  (이미 소재로 사용한 글 제외: ${c.title.slice(0, 30)})`); continue; }
        if (!targets.some((t) => t.mobile === mobile)) targets.push({ ...c, mobile });
        if (targets.length >= maxItems) break;
      }
      log(`[블로그] 글 ${targets.length}개 본문 수집 시작`);
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        try {
          await page.goto(t.mobile, { waitUntil: 'domcontentloaded' });
          await randomWait(page, 2000, 3500);
          const detail = await page.evaluate(BLOG_BODY_FN);
          if (!detail.body || detail.body.length < 100) throw new Error('본문이 비어 있거나 너무 짧음');
          result.blogs.push({
            url: t.mobile,
            title: detail.title || t.title,
            body: detail.body.slice(0, 2000),
          });
          log(`  [${i + 1}/${targets.length}] ${detail.title || t.title}`);
        } catch (e) {
          log(`  ⚠ [${i + 1}] 수집 실패: ${e.message}`);
        }
      }
    }
    // ---------- 3) 근거 자료(통계·조사) ----------
    // 글에 인용할 수치가 없으면 설득력이 떨어지므로 통계·조사 기사를 따로 모은다.
    // (지어낸 수치를 쓰지 않으려면 실제 자료를 수집해 두는 수밖에 없다)
    //
    // ⚠ 주제와 무관한 기사가 섞이면 엉뚱한 통계가 글에 인용되는 사고가 난다
    //   (실제로 "병원 유튜브 마케팅 통계" 검색에 주식·세무 기사가 걸렸음)
    //   → 키워드 토큰이 제목/본문에 2개 이상 나오는 기사만 통과시킨다.
    const tokens = keyword.split(/\s+/).filter((t) => t.length >= 2);
    // "병원", "마케팅" 같은 흔한 단어는 우연히 겹치므로, 그 외의 특징적 토큰을 따로 본다
    const COMMON = ['병원', '마케팅', '광고', '홍보', '의원', '진료'];
    const distinctive = tokens.filter((t) => !COMMON.includes(t));
    const isRelevant = (title, body) => {
      // 제목에 키워드가 하나도 없으면 다른 주제의 기사다
      if (!tokens.some((t) => title.includes(t))) return false;
      const text = `${title} ${body.slice(0, 800)}`;
      // 특징적 토큰이 있으면 그것이 반드시 포함돼야 한다 (유튜브/플레이스/임플란트 등)
      if (distinctive.length && !distinctive.some((t) => text.includes(t))) return false;
      const hit = tokens.filter((t) => text.includes(t)).length;
      return tokens.length <= 1 ? hit >= 1 : hit >= 2;
    };

    log(`[근거자료] "${keyword}" 관련 통계·조사 검색`);
    for (const suffix of ['통계', '조사 결과']) {
      try {
        const cands = await collectSearchLinks(
          page, NEWS_SEARCH(`${keyword} ${suffix}`), 'n\\.news\\.naver\\.com', 1, () => {}
        );
        for (const c of cands.slice(0, 4)) {
          if (result.stats.some((s) => s.url === c.url.split('?')[0])) continue;
          try {
            await page.goto(c.url, { waitUntil: 'domcontentloaded' });
            await randomWait(page, 1200, 2200);
            const detail = await page.evaluate(NEWS_BODY_FN);
            const title = detail.title || c.title;
            const body = (detail.body || '').slice(0, 1500);
            // 수치가 들어있고, 주제와 관련 있는 자료만 근거로 쓴다
            if (!/\d+(\.\d+)?\s?(%|퍼센트|명|건|배|억|만)/.test(body)) continue;
            if (!isRelevant(title, body)) {
              log(`  ✕ 주제와 무관해 제외: ${title.slice(0, 30)}`);
              continue;
            }
            result.stats.push({ url: c.url.split('?')[0], title, body });
            log(`  📊 ${title}`);
          } catch { /* 개별 실패는 건너뜀 */ }
          if (result.stats.length >= 3) break;
        }
      } catch (e) {
        log(`  ⚠ 근거자료 검색 실패: ${e.message.split('\n')[0]}`);
      }
      if (result.stats.length >= 3) break;
    }
    if (!result.stats.length) log('  (인용할 만한 통계 자료가 없어 근거자료 없이 진행합니다)');

    // ---------- 4) 검색 트렌드 (네이버 데이터랩) ----------
    // 뉴스에 통계가 없어도 이건 대부분 데이터가 나온다 — 글의 근거로 가장 확실한 소스.
    // 지역명이 붙은 키워드("부천 병원마케팅")는 검색량이 적어 트렌드가 무의미하므로,
    // 그럴 때는 지역명을 뗀 상위 키워드("병원마케팅")로 한 번 더 조회한다.
    try {
      log(`[검색 트렌드] "${keyword}" 데이터랩 조회`);
      result.trend = await getSearchTrend(keyword, log, context);
      if (!result.trend) {
        const parts = keyword.split(/\s+/);
        const broader = parts.length > 1 ? parts.slice(1).join(' ') : null;
        if (broader && broader.length >= 2) {
          log(`[검색 트렌드] 상위 키워드 "${broader}"로 재시도`);
          result.trend = await getSearchTrend(broader, log, context);
        }
      }
      if (!result.trend) log('  (검색 트렌드 없이 진행합니다)');
    } catch (e) {
      log(`  ⚠ 검색 트렌드 조회 실패: ${e.message.split('\n')[0]}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (!result.news.length && !result.blogs.length) {
    throw new Error('수집된 글감이 없습니다. 다른 키워드로 시도해 보세요.');
  }
  return result;
}

/** 수집 결과를 마크다운으로 변환 */
export function toMarkdown({ keyword, news, blogs, stats = [], trend = null }) {
  const lines = [];
  lines.push(`# 글감 수집 결과: "${keyword}"`);
  lines.push('');
  lines.push(`- 수집 일시: ${new Date().toLocaleString('ko-KR')}`);
  lines.push(`- 뉴스 ${news.length}건 · 블로그 ${blogs.length}건 · 근거자료 ${stats.length}건${trend ? ' · 검색 트렌드 有' : ''}`);
  lines.push('');
  // 검색 트렌드는 항상 확보되는 근거이므로 맨 앞에 배치해 AI가 도입부에 쓰게 한다
  if (trend) {
    lines.push('---');
    lines.push('');
    lines.push(trendToMarkdown(trend));
  }
  const section = (label, items) => {
    if (!items.length) return;
    lines.push(`---`);
    lines.push('');
    lines.push(`# ${label}`);
    lines.push('');
    items.forEach((p, i) => {
      lines.push(`## ${label} ${i + 1}. ${p.title}`);
      lines.push('');
      lines.push(`- URL: ${p.url}`);
      lines.push('');
      lines.push(p.body || '(본문 없음)');
      lines.push('');
    });
  };
  section('뉴스', news);
  section('블로그', blogs);
  // 근거자료는 글에 인용할 수치가 들어있는 자료 — AI가 우선 활용하도록 별도 표기
  if (stats.length) {
    lines.push('---');
    lines.push('');
    lines.push('# 근거자료 (통계·조사) — 글에 인용할 수치');
    lines.push('');
    stats.forEach((p, i) => {
      lines.push(`## 근거자료 ${i + 1}. ${p.title}`);
      lines.push('');
      lines.push(`- 출처 URL: ${p.url}`);
      lines.push('');
      lines.push(p.body || '');
      lines.push('');
    });
  }
  return lines.join('\n');
}
