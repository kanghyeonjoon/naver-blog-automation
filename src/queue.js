import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR, readMd } from './files.js';
import { parsePost } from './post-format.js';
import { prepareImages } from './images.js';
import { publishPost } from './naver-publisher.js';
import { extractSources } from './drafts.js';

const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

const state = {
  items: [],        // { id, draftName, title, status: pending|publishing|done|failed, error, addedAt, publishedAt, url }
  running: false,
  intervalMin: 60,
  nextAt: null,
  logs: [],
};
let timer = null;

function log(msg) {
  state.logs.push({ t: Date.now(), msg });
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
  console.log(`[자동발행] ${msg}`);
}

const BACKUP_FILE = `${QUEUE_FILE}.bak`;

/**
 * 원자적 저장: 임시 파일에 쓴 뒤 교체.
 * 쓰기 도중 중단되어도 기존 파일이나 백업이 남아 대기열이 유실되지 않는다.
 */
function save() {
  const payload = JSON.stringify({ items: state.items, intervalMin: state.intervalMin }, null, 2);
  const tmp = `${QUEUE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, 'utf-8');
    if (fs.existsSync(QUEUE_FILE)) fs.copyFileSync(QUEUE_FILE, BACKUP_FILE);
    fs.renameSync(tmp, QUEUE_FILE);
  } catch (e) {
    console.error('[자동발행] 대기열 저장 실패:', e.message);
  }
}

export function loadQueue() {
  for (const file of [QUEUE_FILE, BACKUP_FILE]) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      state.items = Array.isArray(data.items) ? data.items : [];
      if (data.intervalMin) state.intervalMin = data.intervalMin;
      // 서버 재시작 시 publishing 상태로 남은 항목은 pending으로 복구
      for (const it of state.items) {
        if (it.status === 'publishing') it.status = 'pending';
      }
      const pending = state.items.filter((i) => i.status === 'pending').length;
      if (state.items.length) {
        console.log(`[자동발행] 대기열 복원됨 — 전체 ${state.items.length}개 (대기 ${pending}개)${file === BACKUP_FILE ? ' [백업에서 복구]' : ''}`);
      }
      return;
    } catch { /* 다음 후보(백업) 시도 */ }
  }
}

export function getQueue() {
  return {
    items: state.items,
    running: state.running,
    intervalMin: state.intervalMin,
    nextAt: state.nextAt,
    logs: state.logs.slice(-60),
  };
}

export function addItem({ draftName, title }) {
  if (state.items.some((i) => i.draftName === draftName && (i.status === 'pending' || i.status === 'publishing'))) {
    throw new Error('이미 대기열에 있는 초안입니다.');
  }
  const item = {
    id: randomUUID(),
    draftName,
    title: title || draftName,
    status: 'pending',
    error: null,
    addedAt: Date.now(),
    publishedAt: null,
    url: null,
  };
  state.items.push(item);
  save();
  log(`대기열에 추가됨: "${item.title}" (${state.items.filter((i) => i.status === 'pending').length}개 대기 중)`);
  return item;
}

export function removeItem(id) {
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error('항목을 찾을 수 없습니다.');
  if (state.items[idx].status === 'publishing') throw new Error('지금 발행 중인 항목은 삭제할 수 없습니다.');
  state.items.splice(idx, 1);
  save();
}

export function clearFinished() {
  state.items = state.items.filter((i) => i.status === 'pending' || i.status === 'publishing');
  save();
}

/** 실패한 항목을 다시 대기 상태로 되돌린다 (id 생략 시 모든 실패 항목) */
export function retryItems(id) {
  const targets = id
    ? state.items.filter((i) => i.id === id && i.status === 'failed')
    : state.items.filter((i) => i.status === 'failed');
  if (!targets.length) throw new Error('다시 시도할 실패 항목이 없습니다.');
  for (const it of targets) {
    it.status = 'pending';
    it.error = null;
  }
  save();
  log(`실패 항목 ${targets.length}개를 대기 상태로 되돌렸습니다.`);
  return targets.length;
}

function scheduleNext(delayMs) {
  clearTimeout(timer);
  state.nextAt = Date.now() + delayMs;
  timer = setTimeout(tick, delayMs);
}

export function startQueue(intervalMin) {
  if (state.running) throw new Error('이미 자동 발행이 실행 중입니다.');
  const pending = state.items.filter((i) => i.status === 'pending');
  if (!pending.length) throw new Error('대기열에 발행할 글이 없습니다. 먼저 초안을 추가해 주세요.');
  state.intervalMin = Math.max(1, Number(intervalMin) || 60);
  state.running = true;
  save();
  log(`자동 발행 시작 — ${pending.length}개 글, ${state.intervalMin}분 간격 (첫 글은 즉시 발행)`);
  scheduleNext(3000); // 첫 글은 3초 후 바로 발행
}

export function stopQueue() {
  clearTimeout(timer);
  timer = null;
  state.running = false;
  state.nextAt = null;
  log('자동 발행이 중지되었습니다.');
}

async function tick() {
  if (!state.running) return;
  const item = state.items.find((i) => i.status === 'pending');
  if (!item) {
    log('대기열의 모든 글이 처리되어 자동 발행을 종료합니다.');
    state.running = false;
    state.nextAt = null;
    return;
  }

  item.status = 'publishing';
  save();
  log(`── 발행 시작: "${item.title}"`);
  try {
    const raw = readMd('drafts', item.draftName);
    const parsed = parsePost(raw);
    // 이미지가 아직 준비되지 않았으면 지금 준비
    if (parsed.meta.imageQueries.length) {
      await prepareImages({ draftName: item.draftName, imageQueries: parsed.meta.imageQueries, log });
    }
    const { url } = await publishPost({
      draftName: item.draftName,
      parsed,
      sourceUrls: extractSources(raw),
      log,
    });
    item.status = 'done';
    item.publishedAt = Date.now();
    item.url = url;
    log('── 발행 성공');
  } catch (e) {
    item.status = 'failed';
    item.error = e.message;
    log(`── 발행 실패: ${e.message} (다음 글로 넘어갑니다)`);
  }
  save();

  const remaining = state.items.some((i) => i.status === 'pending');
  if (remaining && state.running) {
    log(`다음 발행은 ${state.intervalMin}분 후입니다.`);
    scheduleNext(state.intervalMin * 60 * 1000);
  } else {
    state.running = false;
    state.nextAt = null;
    log('대기열의 모든 글이 처리되었습니다. 자동 발행 종료.');
  }
}
