/**
 * 초안(draft) 파일 유틸.
 * 초안 md = 중간 마크업(===META=== ... ===END===) + 출처 기록(===SOURCES===).
 * ===END=== 이후 내용은 parsePost가 무시하므로 출처를 뒤에 붙여도 안전하다.
 */

/** 크롤링 md에서 출처 URL 목록 추출 */
export function extractCrawlUrls(crawlMd) {
  const urls = [];
  for (const m of String(crawlMd).matchAll(/^- URL:\s*(\S+)/gm)) {
    urls.push(m[1]);
  }
  return urls;
}

/** 초안 본문 뒤에 출처 섹션을 붙인다 */
export function withSources(draftText, sourceUrls) {
  if (!sourceUrls || !sourceUrls.length) return draftText;
  return `${draftText}\n\n===SOURCES===\n${sourceUrls.join('\n')}\n`;
}

/** 초안에서 출처 URL 목록 추출 */
export function extractSources(draftText) {
  const m = String(draftText).match(/===SOURCES===\s*([\s\S]*?)$/);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l));
}
