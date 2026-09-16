// 네이버 데이터랩 + 검색 API 실제 호출 테스트
const ID = process.argv[2];
const SECRET = process.argv[3];
const H = { 'X-Naver-Client-Id': ID, 'X-Naver-Client-Secret': SECRET };

// 1) 데이터랩 검색어 트렌드
try {
  const body = {
    startDate: '2025-08-01',
    endDate: '2026-07-31',
    timeUnit: 'month',
    keywordGroups: [
      { groupName: '부천 임플란트', keywords: ['부천 임플란트'] },
      { groupName: '병원 유튜브', keywords: ['병원 유튜브'] },
    ],
  };
  const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log('=== 데이터랩 검색어 트렌드 ===');
  console.log('status:', res.status);
  const text = await res.text();
  if (res.ok) {
    const d = JSON.parse(text);
    for (const r of d.results) {
      const pts = r.data;
      const first = pts[0], last = pts[pts.length - 1];
      const max = pts.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      const change = first.ratio ? Math.round(((last.ratio - first.ratio) / first.ratio) * 100) : null;
      console.log(`[${r.title}] ${pts.length}개월치 | 시작 ${first.period} ${first.ratio} → 끝 ${last.period} ${last.ratio} | 변화 ${change}% | 최고 ${max.period}(${max.ratio})`);
    }
  } else {
    console.log('body:', text.slice(0, 300));
  }
} catch (e) {
  console.log('데이터랩 오류:', e.message);
}

// 2) 검색 API (뉴스)
try {
  const res = await fetch('https://openapi.naver.com/v1/search/news.json?query=' + encodeURIComponent('병원 마케팅') + '&display=3&sort=date', { headers: H });
  console.log('\n=== 검색 API (뉴스) ===');
  console.log('status:', res.status);
  const text = await res.text();
  if (res.ok) {
    const d = JSON.parse(text);
    console.log('총 결과:', d.total);
    d.items.forEach((i) => console.log(' -', i.title.replace(/<[^>]+>/g, '')));
  } else {
    console.log('body:', text.slice(0, 300));
  }
} catch (e) {
  console.log('검색 오류:', e.message);
}
