import fs from 'fs';
import path from 'path';
import { FILE_TYPES, PERSONA_CACHE_DIR } from './files.js';

const PERSONA_DIR = FILE_TYPES.persona;

/**
 * data/persona/ 폴더의 스타일 가이드를 모두 읽어 하나의 텍스트로 합친다.
 * - .md / .txt: 그대로 읽음
 * - .pdf: unpdf로 텍스트 추출 후 .cache/에 캐시 (원본 mtime 비교로 무효화)
 * 추출 실패는 경고로만 처리하고 진행한다 (하드 실패 금지).
 */
/**
 * @param mode 'clinic'(병원 명의 환자 대상) | 'column'(몽PD 칼럼). 모드에 맞는 가이드만 주입한다.
 */
export async function loadPersona(log = () => {}, mode = 'column') {
  if (!fs.existsSync(PERSONA_DIR)) return '';
  const all = fs.readdirSync(PERSONA_DIR).filter((f) => /\.(md|txt|pdf)$/i.test(f));
  // 두 모드의 가이드가 섞여 들어가면 문체가 뒤엉키므로 파일명으로 갈라 쓴다
  const isClinicGuide = (f) => /원고-작성규칙/.test(f);
  const files = all.filter((f) => (mode === 'clinic' ? isClinicGuide(f) : !isClinicGuide(f)));
  const parts = [];
  for (const f of files) {
    const full = path.join(PERSONA_DIR, f);
    try {
      if (/\.pdf$/i.test(f)) {
        parts.push(await extractPdfCached(full, f, log));
      } else {
        parts.push(fs.readFileSync(full, 'utf-8'));
      }
    } catch (e) {
      log(`⚠ 페르소나 파일 "${f}" 읽기 실패: ${e.message} — 건너뜁니다.`);
    }
  }
  return parts.filter((p) => p && p.trim()).join('\n\n---\n\n');
}

async function extractPdfCached(fullPath, name, log) {
  const st = fs.statSync(fullPath);
  const cacheFile = path.join(PERSONA_CACHE_DIR, `${name}.txt`);
  const metaFile = path.join(PERSONA_CACHE_DIR, `${name}.meta.json`);
  // 캐시 유효성: 원본 mtime 일치
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    if (meta.mtime === st.mtimeMs) return fs.readFileSync(cacheFile, 'utf-8');
  } catch { /* 캐시 없음 → 추출 */ }

  log(`PDF 스타일 가이드 추출 중: ${name}...`);
  const { extractText, getDocumentProxy } = await import('unpdf');
  const buffer = new Uint8Array(fs.readFileSync(fullPath));
  const pdf = await getDocumentProxy(buffer);
  const { text } = await extractText(pdf, { mergePages: true });
  const result = String(text || '').trim();
  if (!result) {
    log(`⚠ "${name}"에서 텍스트를 추출하지 못했습니다 (스캔본 PDF일 수 있음).`);
    return '';
  }
  fs.mkdirSync(PERSONA_CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, result, 'utf-8');
  fs.writeFileSync(metaFile, JSON.stringify({ mtime: st.mtimeMs }), 'utf-8');
  log(`PDF 추출 완료 (${result.length}자, 캐시 저장됨)`);
  return result;
}

/** 설정 화면용: 페르소나 파일 목록과 상태 */
export function personaStatus() {
  if (!fs.existsSync(PERSONA_DIR)) return { files: [] };
  const files = fs.readdirSync(PERSONA_DIR)
    .filter((f) => /\.(md|txt|pdf)$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(PERSONA_DIR, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    });
  return { files, dir: PERSONA_DIR };
}
