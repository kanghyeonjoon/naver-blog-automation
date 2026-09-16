/**
 * AI 중간 포맷 파서.
 *
 * AI가 출력하는 라인 기반 마크업:
 *
 * ===META===
 * title: 제목 한 줄
 * tags: 태그1, 태그2, 태그3
 * images: cozy cafe interior | pour over coffee closeup
 * ===BODY===
 * [H] 소제목
 * 일반 문단 (빈 줄로 구분)
 * [QUOTE] 인용구 문장
 * [IMG:1]
 * [HR]
 * ===END===
 *
 * 파싱 결과: { meta: {title, tags[], imageQueries[]}, blocks: [{type, text?, imageIndex?}] }
 * block type: heading | para | quote | divider | image
 */

export function parsePost(raw) {
  const text = String(raw || '');
  const metaMatch = text.match(/===META===\s*([\s\S]*?)===BODY===/);
  const bodyMatch = text.match(/===BODY===\s*([\s\S]*?)(?:===END===|$)/);
  if (!metaMatch || !bodyMatch) {
    throw new Error('===META=== / ===BODY=== 마커를 찾을 수 없습니다.');
  }

  // ---------- META ----------
  const meta = { title: '', tags: [], imageQueries: [] };
  for (const line of metaMatch[1].split('\n')) {
    const m = line.match(/^\s*(title|tags|images)\s*:\s*(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'title') meta.title = val;
    if (key === 'tags') {
      meta.tags = val.split(',').map((t) => t.replace(/^#/, '').trim()).filter(Boolean).slice(0, 10);
    }
    if (key === 'images') {
      meta.imageQueries = val.split('|').map((q) => q.trim()).filter(Boolean).slice(0, 10);
    }
  }

  // ---------- BODY ----------
  const blocks = [];
  const lines = bodyMatch[1].split('\n');
  let paraBuf = [];
  const flushPara = () => {
    const t = paraBuf.join('\n').trim();
    if (t) blocks.push({ type: 'para', text: t });
    paraBuf = [];
  };
  // [CASE] ... [/CASE] 는 여러 줄짜리 환자 사례 박스 — 그 안의 빈 줄까지 그대로 보존한다
  let caseBuf = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (caseBuf) {
      if (/^\[\/CASE\]$/.test(trimmed)) {
        const t = caseBuf.join('\n').trim();
        if (t) blocks.push({ type: 'case', text: t });
        caseBuf = null;
      } else {
        caseBuf.push(line);
      }
      continue;
    }

    const caseOpen = trimmed.match(/^\[CASE\]\s*(.*)$/);
    if (caseOpen) {
      flushPara();
      caseBuf = caseOpen[1].trim() ? [caseOpen[1].trim()] : [];
      continue;
    }

    if (!trimmed) { flushPara(); continue; }
    const h = trimmed.match(/^\[H\]\s*(.+)$/);
    const q = trimmed.match(/^\[QUOTE\]\s*(.+)$/);
    const img = trimmed.match(/^\[IMG:(\d+)\]$/);
    const hr = /^\[HR\]$/.test(trimmed);
    if (h) { flushPara(); blocks.push({ type: 'heading', text: h[1].trim() }); continue; }
    if (q) { flushPara(); blocks.push({ type: 'quote', text: q[1].trim() }); continue; }
    if (img) { flushPara(); blocks.push({ type: 'image', imageIndex: Number(img[1]) }); continue; }
    if (hr) { flushPara(); blocks.push({ type: 'divider' }); continue; }
    paraBuf.push(line);
  }
  // [/CASE]가 없이 끝난 경우도 살린다
  if (caseBuf) {
    const t = caseBuf.join('\n').trim();
    if (t) blocks.push({ type: 'case', text: t });
  }
  flushPara();

  // 연속된 [H]는 하나의 소제목으로 병합한다 (AI가 2줄 소제목을 [H] 두 개로 쓰는 경우가 많은데,
  // 별도 블록으로 두면 사이에 문단 간격이 들어가 소제목 두 개처럼 보임)
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (b.type === 'heading' && prev && prev.type === 'heading') {
      // 공백으로 합친다 (줄바꿈으로 두면 에디터에서 여러 줄 서식 적용이 불안정 —
      // 한 줄로 넣어도 모바일 화면 폭에서 자연스럽게 두 줄로 표시된다)
      prev.text = `${prev.text} ${b.text}`;
    } else {
      merged.push(b);
    }
  }

  return { meta, blocks: merged };
}

/** 파싱 결과 검증. 문제가 있으면 오류 메시지 배열 반환 (비어있으면 통과) */
export function validatePost({ meta, blocks }) {
  const errors = [];
  if (!meta.title) errors.push('title이 비어 있습니다.');
  const bodyLen = blocks.filter((b) => b.text).reduce((s, b) => s + b.text.length, 0);
  if (bodyLen < 500) errors.push(`본문이 너무 짧습니다 (${bodyLen}자, 최소 500자).`);
  const imgIndexes = blocks.filter((b) => b.type === 'image').map((b) => b.imageIndex);
  for (const idx of imgIndexes) {
    if (idx < 1 || idx > meta.imageQueries.length) {
      errors.push(`[IMG:${idx}]에 해당하는 images 검색어가 없습니다 (검색어 ${meta.imageQueries.length}개).`);
    }
  }
  return errors;
}

/** 파싱 결과를 다시 중간 마크업 텍스트로 직렬화 (초안 저장/수정용) */
export function serializePost({ meta, blocks }) {
  const out = [];
  out.push('===META===');
  out.push(`title: ${meta.title}`);
  out.push(`tags: ${meta.tags.join(', ')}`);
  out.push(`images: ${meta.imageQueries.join(' | ')}`);
  out.push('===BODY===');
  for (const b of blocks) {
    if (b.type === 'heading') out.push(`[H] ${b.text}`);
    else if (b.type === 'quote') out.push(`[QUOTE] ${b.text}`);
    else if (b.type === 'case') out.push(`[CASE]\n${b.text}\n[/CASE]`);
    else if (b.type === 'image') out.push(`[IMG:${b.imageIndex}]`);
    else if (b.type === 'divider') out.push('[HR]');
    else out.push(b.text);
    out.push('');
  }
  out.push('===END===');
  return out.join('\n');
}
