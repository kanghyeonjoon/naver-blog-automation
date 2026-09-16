import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './files.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  blogId: '',            // 네이버 블로그 ID (예: mongpd). 비워두면 로그인 세션의 기본 블로그 사용
  category: '',          // 기본 카테고리명 (비우면 기본 카테고리로 발행)
  visibility: '전체공개',  // 전체공개 | 이웃공개 | 서로이웃공개 | 비공개
  headingStyle: 'center',  // 소제목 모양: center(가운데 텍스트+구분선, 사용자 선택) | corner(모서리 박스) | underline(밑줄)
  pexelsKey: '',         // https://www.pexels.com/api/ 에서 무료 발급
  pixabayKey: '',        // https://pixabay.com/api/docs/ 에서 무료 발급
};

export function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(partial) {
  const merged = { ...loadConfig() };
  for (const key of Object.keys(DEFAULTS)) {
    if (partial[key] !== undefined) merged[key] = String(partial[key]).trim();
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/** API 응답용 — 키는 마스킹해서 노출 */
export function publicConfig() {
  const c = loadConfig();
  return {
    ...c,
    pexelsKey: c.pexelsKey ? `${c.pexelsKey.slice(0, 4)}****` : '',
    pixabayKey: c.pixabayKey ? `${c.pixabayKey.slice(0, 4)}****` : '',
    hasPexelsKey: !!c.pexelsKey,
    hasPixabayKey: !!c.pixabayKey,
  };
}
