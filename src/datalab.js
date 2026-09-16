import { chromium } from 'playwright';

/**
 * 네이버 데이터랩(datalab.naver.com) 검색어 트렌드 수집.
 *
 * 데이터랩 오픈 API는 애플리케이션에 권한을 줄 수 없어(신규 신청 목록에 없음) 401이 난다.
 * 대신 로그인 없이 열리는 데이터랩 웹 페이지에서 그래프 데이터를 직접 읽는다.
 * (SVG의 데이터 포인트 y좌표를 Y축 눈금으로 보간해 0~100 상대값으로 환산)
 *
 * 반환값은 "상대적 변화"라서 절대 검색량이 아니다 — 글에 쓸 때도 그렇게 표현해야 한다.
 */
const TREND_URL = 'https://datalab.naver.com/keyword/trendSearch.naver';

/**
 * @param existingContext 이미 열려 있는 브라우저 컨텍스트가 있으면 재사용한다
 *        (크롤링 중에 호출할 때 브라우저를 두 번 띄우지 않기 위함)
 */
export async function getSearchTrend(keyword, log = () => {}, existingContext = null) {
  const browser = existingContext ? null : await chromium.launch({ headless: false });
  const context = existingContext
    || (await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 900 } }));
  let page = null;
  try {
    page = await context.newPage();
    await page.goto(TREND_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // 주제어 이름 + 하위 키워드 입력
    await page.locator('#item_keyword1').first().fill(keyword);
    const kw = page.locator('input[placeholder*="키워드"]').first();
    if (await kw.count()) {
      await kw.fill(keyword);
      await kw.press('Enter');
    }
    await page.waitForTimeout(600);

    // 기간: 최근 1년 (라디오가 있으면 선택)
    for (const sel of ['a:has-text("1년")', 'label:has-text("1년")', 'input[value="1y"]']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click().catch(() => {}); break; }
    }
    await page.waitForTimeout(400);

    const btn = page.locator('a:has-text("네이버 검색 데이터 조회"), button:has-text("조회")').first();
    if (!(await btn.count())) throw new Error('조회 버튼을 찾지 못했습니다.');
    await btn.click();
    await page.waitForTimeout(6000);

    // SVG에서 데이터 포인트와 Y축 눈금을 읽어 값으로 환산
    const data = await page.evaluate(() => {
      const svg = document.querySelector('.graph_wrap svg, svg');
      if (!svg) return null;
      // 데이터 포인트와 축 라벨의 좌표계를 통일하기 위해 둘 다 화면 좌표(getBoundingClientRect)로 읽는다
      // (text 요소는 y 속성 대신 transform으로 배치되는 경우가 있어 속성만 읽으면 NaN이 난다)
      const midY = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      const midX = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };

      const circles = [...svg.querySelectorAll('circle')]
        .map((c) => ({ x: midX(c), y: midY(c) }))
        .filter((p) => !isNaN(p.x) && !isNaN(p.y))
        .sort((a, b) => a.x - b.x);
      if (circles.length < 3) return null;

      // Y축 눈금(0/25/50/75/100)의 화면 좌표로 선형 보간식을 만든다
      const ticks = [...svg.querySelectorAll('text')]
        .filter((t) => /^\d+$/.test(t.textContent.trim()))
        .map((t) => ({ value: Number(t.textContent.trim()), y: midY(t) }))
        .filter((t) => !isNaN(t.y))
        .sort((a, b) => a.value - b.value);
      if (ticks.length < 2 || ticks[0].y === ticks[ticks.length - 1].y) return null;
      const low = ticks[0];             // 보통 0
      const high = ticks[ticks.length - 1]; // 보통 100
      const toValue = (y) => {
        const ratio = (low.y - y) / (low.y - high.y);
        return Math.round(ratio * (high.value - low.value) + low.value);
      };

      // X축 날짜 라벨 (개수가 데이터 포인트와 다르므로 시작/끝 참고용)
      const dates = [...svg.querySelectorAll('text')]
        .map((t) => t.textContent.trim())
        .filter((s) => /\d+\.\d+/.test(s));

      const values = circles.map((c) => toValue(c.y));
      return { values, dates, count: values.length };
    });

    if (!data || !data.values.length) throw new Error('그래프 데이터를 읽지 못했습니다.');

    const { values, dates } = data;
    const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);

    // 검색량이 거의 없는 키워드는 대부분 0이고 가끔 튀는 값만 있어
    // "100% 감소" 같은 엉터리 결론이 나온다 → 근거로 쓸 수 없다고 판단한다.
    const nonZeroRatio = values.filter((v) => v > 0).length / values.length;
    const overall = avg(values);
    if (nonZeroRatio < 0.6 || overall < 8) {
      log(`  ⚠ "${keyword}"는 검색량이 적어 트렌드를 근거로 쓸 수 없습니다 (유효 데이터 ${Math.round(nonZeroRatio * 100)}%, 평균 ${overall})`);
      return null;
    }

    // 시작/끝 구간은 노이즈가 크므로 앞뒤 10%씩 평균내어 비교
    const span = Math.max(1, Math.round(values.length * 0.1));
    const startAvg = avg(values.slice(0, span));
    const endAvg = avg(values.slice(-span));
    const change = startAvg ? Math.round(((endAvg - startAvg) / startAvg) * 100) : null;
    // 감소 추세는 글의 근거로 쓰면 역효과다(업계가 위축된다는 인상) → 근거로 제공하지 않는다.
    // 데이터가 없으면 그냥 트렌드 없이 쓰면 되므로, 억지로 넣는 것보다 낫다.
    if (change === null || change < 5) {
      log(`  (검색 관심도가 늘지 않아 근거로 쓰지 않습니다: ${change}%)`);
      return null;
    }

    const peakIdx = values.indexOf(Math.max(...values));
    const peakRatio = peakIdx / Math.max(1, values.length - 1);

    const result = {
      keyword,
      pointCount: values.length,
      startValue: startAvg,
      endValue: endAvg,
      changePercent: change,
      peakValue: values[peakIdx],
      peakPosition: peakRatio, // 0=조회 시작 시점, 1=최근
      periodLabel: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : '최근 1년',
    };
    log(`  📈 "${keyword}" 검색 트렌드: ${change > 0 ? '+' : ''}${change}% (${result.periodLabel})`);
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
    else if (page) await page.close().catch(() => {}); // 넘겨받은 컨텍스트는 닫지 않는다
  }
}

/** 트렌드 결과를 글감 마크다운에 넣을 문단으로 변환 */
export function trendToMarkdown(trend) {
  if (!trend) return '';
  const dir = trend.changePercent > 0 ? '증가' : trend.changePercent < 0 ? '감소' : '보합';
  const when = trend.peakPosition > 0.66 ? '최근' : trend.peakPosition > 0.33 ? '중간 시점' : '조회 초반';
  return [
    `## 검색 트렌드 (네이버 데이터랩)`,
    '',
    `- 키워드: "${trend.keyword}"`,
    `- 조회 기간: ${trend.periodLabel}`,
    `- 검색 관심도 변화: 기간 초반 대비 **약 ${Math.abs(trend.changePercent)}% ${dir}**`,
    `- 최고 관심 시점: ${when}`,
    '',
    `※ 네이버 데이터랩의 상대 지표(기간 내 최다 검색량을 100으로 환산)입니다. 절대 검색 건수가 아니므로 "검색량이 N건"이라고 쓰지 말고 "검색 관심도가 약 N% 늘었다"처럼 표현해야 합니다.`,
    '',
  ].join('\n');
}
