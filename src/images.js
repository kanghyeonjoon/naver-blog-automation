import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import { draftImagesDir } from './files.js';
import { hasClipartSession, downloadClipartImages } from './clipart.js';

/**
 * 무료 스톡 사진 검색·다운로드.
 * 체인: Pexels(키) → Pixabay(키) → Openverse(키 불필요) → LoremFlickr(키 불필요).
 * API 키가 하나도 없어도 Openverse/LoremFlickr로 이미지를 확보한다.
 * 전부 실패하면 해당 이미지는 건너뛴다 (발행은 계속 진행).
 */

async function searchPexels(query, key) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels API 오류 (${res.status})`);
  const data = await res.json();
  const photo = data.photos?.[0];
  return photo ? photo.src?.large : null;
}

async function searchPixabay(query, key) {
  const url = `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=3&orientation=horizontal&image_type=photo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay API 오류 (${res.status})`);
  const data = await res.json();
  const hit = data.hits?.[0];
  return hit ? (hit.largeImageURL || hit.webformatURL) : null;
}

/** Openverse — CC 라이선스 이미지 검색, API 키 불필요 (익명 사용 가능) */
async function searchOpenverse(query) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial&per_page=5`;
  const res = await fetch(url, { headers: { 'User-Agent': 'naver-blog-automation/1.0' } });
  if (!res.ok) throw new Error(`Openverse API 오류 (${res.status})`);
  const data = await res.json();
  const hit = (data.results || []).find((r) => r.url && /\.(jpe?g|png)/i.test(r.url)) || data.results?.[0];
  return hit ? hit.url : null;
}

/** LoremFlickr — 키워드 기반 무료 이미지, API 키 불필요 (최후 폴백) */
function loremFlickrUrl(query) {
  const tags = query.split(/\s+/).filter(Boolean).slice(0, 3).join(',');
  return `https://loremflickr.com/1280/720/${encodeURIComponent(tags)}`;
}

async function download(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`이미지 다운로드 실패 (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/**
 * 초안의 이미지 검색어 목록으로 스톡 사진을 검색·다운로드한다.
 * @returns {Promise<{images: Array<{index, query, file: string|null, error?: string}>}>}
 */
export async function prepareImages({ draftName, imageQueries, log, skipSessionCheck = false }) {
  const config = loadConfig();
  const dir = draftImagesDir(draftName);
  fs.mkdirSync(dir, { recursive: true });
  const images = [];

  // 0순위: 클립아트코리아 (유료 멤버십 세션이 있으면) — 한국어 검색이라 품질이 가장 좋음
  if (hasClipartSession()) {
    const jobs = imageQueries
      .map((q, i) => ({ query: q, index: i + 1, filePath: path.join(dir, `img-${i + 1}.jpg`) }))
      .filter((j) => !fs.existsSync(j.filePath));
    if (jobs.length) {
      log(`클립아트코리아에서 이미지 ${jobs.length}개 검색·다운로드 시작...`);
      try {
        await downloadClipartImages({ jobs, log });
      } catch (e) {
        // 세션 만료는 사용자가 바로 알아야 하는 문제 (무료 소스로 넘어가면 조용히 품질이 떨어짐)
        if (/세션이 만료/.test(e.message)) throw e;
        log(`⚠ 클립아트코리아 연동 실패: ${e.message} — 다른 소스로 진행`);
      }
    }
  } else if (!config.pexelsKey && !config.pixabayKey) {
    log('ℹ 클립아트코리아 세션·이미지 API 키가 없어 무료 소스(Openverse → LoremFlickr)로 검색합니다. 설정 탭에서 클립아트코리아 로그인을 권장합니다.');
  }

  // 제공자 체인: 키 있는 것 → 키 불필요한 것 순서
  // ⚠ 클립아트코리아를 쓰는 경우 무료 소스로 넘어가지 않는다 —
  //   Openverse·LoremFlickr는 주제와 무관한 사진이 나와도 걸러낼 방법이 없어
  //   "이게 뭐야, 연관성도 없고" 같은 사고가 난다. 차라리 그 자리는 이미지 없이 둔다.
  const providers = [];
  if (!hasClipartSession()) {
    if (config.pexelsKey) providers.push({ name: 'Pexels', search: (q) => searchPexels(q, config.pexelsKey) });
    if (config.pixabayKey) providers.push({ name: 'Pixabay', search: (q) => searchPixabay(q, config.pixabayKey) });
    providers.push({ name: 'Openverse', search: (q) => searchOpenverse(q) });
    providers.push({ name: 'LoremFlickr', search: (q) => Promise.resolve(loremFlickrUrl(q)) });
  }

  for (let i = 0; i < imageQueries.length; i++) {
    const query = imageQueries[i];
    const filePath = path.join(dir, `img-${i + 1}.jpg`);
    // 이미 다운로드된 파일은 재사용
    if (fs.existsSync(filePath)) {
      log(`[이미지 ${i + 1}] 이미 준비됨: ${query}`);
      images.push({ index: i + 1, query, file: filePath });
      continue;
    }

    let done = false;
    let lastErr = null;
    for (const provider of providers) {
      try {
        const url = await provider.search(query);
        if (!url) continue;
        await download(url, filePath);
        // 지나치게 작은 파일(오류 페이지 등)은 실패 처리
        if (fs.statSync(filePath).size < 5000) {
          fs.unlinkSync(filePath);
          throw new Error('다운로드된 파일이 비정상적으로 작음');
        }
        log(`[이미지 ${i + 1}] ✅ ${provider.name}에서 다운로드 완료: "${query}"`);
        images.push({ index: i + 1, query, file: filePath });
        done = true;
        break;
      } catch (e) {
        lastErr = e;
        log(`[이미지 ${i + 1}] ⚠ ${provider.name} 실패: ${e.message}`);
      }
    }
    if (!done) {
      images.push({ index: i + 1, query, file: null, error: lastErr?.message || '모든 소스에서 검색 실패' });
    }
  }

  const ok = images.filter((im) => im.file).length;
  log(`이미지 준비 완료: ${ok}/${imageQueries.length}개`);
  return { images };
}

/** 초안의 준비된 이미지 파일 목록 조회 */
export function listPreparedImages(draftName) {
  const dir = draftImagesDir(draftName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^img-\d+\.jpg$/.test(f))
    .map((f) => ({
      index: Number(f.match(/img-(\d+)/)[1]),
      file: path.join(dir, f),
      name: f,
    }))
    .sort((a, b) => a.index - b.index);
}
