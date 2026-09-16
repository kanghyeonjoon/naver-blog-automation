import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './files.js';

const USED_FILE = path.join(DATA_DIR, 'used-topics.json');

// [{ key: 정규화된 제목, title, sourceUrls: [], publishedAt }]
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(USED_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(items) {
  // 원자적 저장 (queue.js와 동일 패턴)
  const tmp = `${USED_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
  fs.renameSync(tmp, USED_FILE);
}

export function normalizeTitle(title) {
  return String(title).toLowerCase().replace(/[\s\p{P}]+/gu, '').slice(0, 60);
}

/** 발행 성공 시 기록 */
export function markPublished({ title, sourceUrls = [] }) {
  const items = load();
  items.push({
    key: normalizeTitle(title),
    title,
    sourceUrls,
    publishedAt: Date.now(),
  });
  save(items);
}

/** 크롤링 시 이미 소재로 쓴 URL인지 확인 */
export function isUsedUrl(url) {
  const clean = String(url).split('?')[0];
  return load().some((it) => (it.sourceUrls || []).some((u) => String(u).split('?')[0] === clean));
}

/** 생성 프롬프트에 주입할 최근 발행 제목 목록 (주제 중복 회피용) */
export function recentTitles(limit = 20) {
  return load().slice(-limit).map((it) => it.title);
}

export function topicsStatus() {
  const items = load();
  return { total: items.length, recent: items.slice(-10).map((i) => i.title) };
}

export function resetTopics() {
  save([]);
}
