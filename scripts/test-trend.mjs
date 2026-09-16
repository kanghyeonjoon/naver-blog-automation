import { getSearchTrend, trendToMarkdown } from '../src/datalab.js';
const t = await getSearchTrend(process.argv[2] || '부천 임플란트', console.log);
console.log(JSON.stringify(t, null, 2));
console.log('\n--- 글감용 마크다운 ---\n' + trendToMarkdown(t));
