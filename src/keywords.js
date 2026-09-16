import fs from 'fs';
import path from 'path';
import { FILE_TYPES } from './files.js';

/**
 * data/ideas/*.md 의 "## 핵심 키워드" 섹션에서 수집용 키워드를 파싱한다.
 * - 일반 줄: 쉼표로 구분된 키워드 목록
 * - "진료과별: a, b" 줄: 각 항목을 "{진료과} 마케팅" 키워드로 확장
 * - "지역별: a, b" 줄: 각 항목을 "{지역} 병원마케팅" 키워드로 확장
 */
export function loadKeywords() {
  const dir = FILE_TYPES.ideas;
  if (!fs.existsSync(dir)) return [];
  const keywords = [];
  const seen = new Set();
  const add = (kw) => {
    const k = kw.trim().replace(/\(([^)]*)\)/g, '').trim();
    if (k && k.length > 1 && !seen.has(k)) {
      seen.add(k);
      keywords.push(k);
    }
  };

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const m = content.match(/##\s*핵심 키워드[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
    if (!m) continue;
    for (const rawLine of m[1].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const dept = line.match(/^진료과별\s*:\s*(.+)$/);
      const region = line.match(/^지역별\s*:\s*(.+)$/);
      if (dept) {
        dept[1].split(',').forEach((d) => add(`${d.trim()} 마케팅`));
      } else if (region) {
        region[1].split(',').forEach((r) => add(`${r.trim()} 병원마케팅`));
      } else {
        line.split(',').forEach(add);
      }
    }
  }
  return keywords;
}

/**
 * data/ideas/*.md 의 "실제 사용한 제목 목록"에서 제목 예시를 뽑는다.
 * 생성 프롬프트에 넣어 제목이 한 가지 패턴으로 굳는 것을 막는 용도.
 */
export function loadTitleExamples(limit = 18) {
  const dir = FILE_TYPES.ideas;
  if (!fs.existsSync(dir)) return [];
  const titles = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const section = content.match(/##\s*실제 사용한 제목[^\n]*\n([\s\S]*)$/);
    if (!section) continue;
    for (const line of section[1].split('\n')) {
      const m = line.match(/^-\s+(.+)$/);
      if (m && m[1].trim().length > 8) titles.push(m[1].trim());
    }
  }
  // 매번 다른 예시가 들어가도록 섞어서 일부만 반환
  for (let i = titles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [titles[i], titles[j]] = [titles[j], titles[i]];
  }
  return titles.slice(0, limit);
}

export function randomKeyword() {
  const list = loadKeywords();
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}
