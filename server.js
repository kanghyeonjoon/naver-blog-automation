import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  ensureDirs, saveMd, overwriteMd, listMd, readMd, deleteMd, sessionInfo, draftImagesDir,
} from './src/files.js';
import { loadConfig, saveConfig, publicConfig } from './src/config.js';
import { saveLoginSession, checkNaverSession } from './src/naver-auth.js';
import { saveClipartLoginSession, clipartSessionInfo, checkClipartSession, hasClipartSession } from './src/clipart.js';
import { crawl, toMarkdown } from './src/naver-crawler.js';
import { generatePost } from './src/ai.js';
import { parsePost, validatePost, serializePost } from './src/post-format.js';
import { prepareImages, listPreparedImages } from './src/images.js';
import { publishPost } from './src/naver-publisher.js';
import { personaStatus } from './src/persona.js';
import { topicsStatus, resetTopics } from './src/topics.js';
import { extractCrawlUrls, withSources, extractSources } from './src/drafts.js';
import { loadKeywords } from './src/keywords.js';
import {
  loadQueue, getQueue, addItem, removeItem, clearFinished, retryItems, startQueue, stopQueue,
} from './src/queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3580;

ensureDirs();
loadQueue();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 잡(작업) 관리: 오래 걸리는 작업은 잡으로 실행하고 UI가 폴링 ----------
const jobs = new Map();

function startJob(type, fn) {
  const id = randomUUID();
  const job = { id, type, status: 'running', logs: [], result: null, error: null, startedAt: Date.now() };
  jobs.set(id, job);
  const log = (msg) => {
    job.logs.push({ t: Date.now(), msg });
    console.log(`[${type}] ${msg}`);
  };
  (async () => {
    try {
      job.result = await fn(log);
      job.status = 'done';
      log('작업 완료');
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      log(`오류: ${e.message}`);
    }
  })();
  return job;
}

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

// ---------- 로그인 세션 / 설정 ----------
app.get('/api/session', (req, res) => res.json(sessionInfo()));

app.post('/api/login', (req, res) => {
  const job = startJob('login', async (log) => {
    await saveLoginSession(log);
    return { ok: true };
  });
  res.json({ jobId: job.id });
});

app.get('/api/clipart-session', (req, res) => res.json(clipartSessionInfo()));

app.post('/api/clipart-login', (req, res) => {
  const job = startJob('clipart-login', async (log) => {
    await saveClipartLoginSession(log);
    return { ok: true };
  });
  res.json({ jobId: job.id });
});

app.get('/api/config', (req, res) => res.json(publicConfig()));

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  // 마스킹된 키("abcd****")가 그대로 돌아오면 기존 값 유지
  for (const k of ['pexelsKey', 'pixabayKey']) {
    if (typeof body[k] === 'string' && body[k].includes('****')) delete body[k];
  }
  saveConfig(body);
  res.json(publicConfig());
});

app.get('/api/persona', (req, res) => res.json(personaStatus()));

// 저장된 키워드 목록 (data/ideas/*.md의 "핵심 키워드" 섹션)
app.get('/api/keywords', (req, res) => res.json({ keywords: loadKeywords() }));

// ---------- 글감 수집 ----------
app.post('/api/crawl', (req, res) => {
  const { keyword, sources = ['news', 'blog'], maxItems = 5 } = req.body || {};
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: '키워드를 입력해 주세요.' });
  const srcList = (Array.isArray(sources) ? sources : []).filter((s) => ['news', 'blog'].includes(s));
  if (!srcList.length) return res.status(400).json({ error: '뉴스/블로그 중 하나 이상을 선택해 주세요.' });
  const job = startJob('crawl', async (log) => {
    const result = await crawl({
      keyword: keyword.trim(),
      sources: srcList,
      maxItems: Math.min(Math.max(Number(maxItems) || 5, 1), 15),
      log,
    });
    const md = toMarkdown({ keyword: keyword.trim(), ...result });
    const fileName = saveMd('crawls', `글감_${keyword.trim()}`, md);
    log(`저장됨: ${fileName}`);
    return { fileName, newsCount: result.news.length, blogCount: result.blogs.length, content: md };
  });
  res.json({ jobId: job.id });
});

// ---------- AI 글 생성 ----------
app.post('/api/generate', (req, res) => {
  const { crawlFile, instruction = '', clinic = {} } = req.body || {};
  if (!crawlFile) return res.status(400).json({ error: '글감 파일을 선택해 주세요.' });
  const cleanClinic = {
    name: String(clinic.name || '').trim(),
    doctor: String(clinic.doctor || '').trim(),
    dept: String(clinic.dept || '').trim(),
    topic: String(clinic.topic || '').trim(),
  };
  const job = startJob('generate', async (log) => {
    const crawlContent = readMd('crawls', crawlFile);
    const { parsed } = await generatePost({
      crawlContent,
      instruction: String(instruction).trim(),
      clinic: cleanClinic,
      log,
    });
    const draftText = withSources(serializePost(parsed), extractCrawlUrls(crawlContent));
    const base = crawlFile.replace(/^글감_/, '').replace(/_\d{8}_\d{6}\.md$/, '');
    const fileName = saveMd('drafts', `초안_${base}`, draftText);
    log(`초안 저장됨: ${fileName}`);
    return { fileName, title: parsed.meta.title, content: draftText, parsed };
  });
  res.json({ jobId: job.id });
});

// ---------- 초안 ----------
app.get('/api/drafts', (req, res) => res.json(listMd('drafts')));

app.get('/api/draft', (req, res) => {
  const { name } = req.query;
  try {
    const content = readMd('drafts', name);
    let parsed = null;
    let parseError = null;
    try {
      parsed = parsePost(content);
    } catch (e) {
      parseError = e.message;
    }
    const images = listPreparedImages(name).map((im) => ({ index: im.index, name: im.name }));
    res.json({ name, content, parsed, parseError, images, sources: extractSources(content) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/draft', (req, res) => {
  const { name, content } = req.body || {};
  if (!name || !content) return res.status(400).json({ error: '이름과 내용이 필요합니다.' });
  try {
    // 저장 전 형식 검증 (실패해도 저장은 하되 경고 반환)
    let warnings = [];
    try {
      const parsed = parsePost(content);
      warnings = validatePost(parsed);
    } catch (e) {
      warnings = [e.message];
    }
    overwriteMd('drafts', name, content);
    res.json({ ok: true, warnings });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 초안의 준비된 이미지 파일 서빙 (미리보기용)
app.get('/api/draft-image', (req, res) => {
  const { name, index } = req.query;
  const dir = draftImagesDir(path.basename(String(name || '')));
  const file = path.join(dir, `img-${Number(index) || 0}.jpg`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// ---------- 이미지 준비 ----------
app.post('/api/images/prepare', (req, res) => {
  const { draftName } = req.body || {};
  if (!draftName) return res.status(400).json({ error: '초안을 선택해 주세요.' });
  const job = startJob('images', async (log) => {
    const content = readMd('drafts', draftName);
    const parsed = parsePost(content);
    if (!parsed.meta.imageQueries.length) {
      log('이미지 검색어가 없는 초안입니다.');
      return { images: [] };
    }
    return prepareImages({ draftName, imageQueries: parsed.meta.imageQueries, log });
  });
  res.json({ jobId: job.id });
});

// 발행·자동생성처럼 오래 걸리는 작업 전에 로그인 세션이 살아있는지 먼저 확인한다.
// (예전엔 이미지까지 다 준비한 뒤 마지막 발행 단계에서야 만료를 알게 돼 시간을 버렸다)
async function assertSessionsAlive(log, { needClipart = true } = {}) {
  log('로그인 세션 확인 중...');
  const naver = await checkNaverSession();
  if (!naver.ok) throw new Error(naver.reason);
  if (naver.warn) log(`⚠ ${naver.warn}`);

  if (needClipart && hasClipartSession()) {
    const ck = await checkClipartSession();
    if (!ck.ok) throw new Error(ck.reason);
    if (ck.warn) log(`⚠ ${ck.warn}`);
  }
  log('세션 확인 완료 — 작업을 시작합니다.');
}

app.get('/api/session-check', async (req, res) => {
  const [naver, clipart] = await Promise.all([
    checkNaverSession(),
    hasClipartSession() ? checkClipartSession() : Promise.resolve({ ok: false, reason: '클립아트코리아 로그인 세션이 없습니다.' }),
  ]);
  res.json({ naver, clipart });
});

// ---------- 발행 ----------
app.post('/api/publish', (req, res) => {
  const { draftName } = req.body || {};
  if (!draftName) return res.status(400).json({ error: '발행할 초안을 선택해 주세요.' });
  const job = startJob('publish', async (log) => {
    await assertSessionsAlive(log, { needClipart: false });
    const content = readMd('drafts', draftName);
    const parsed = parsePost(content);
    const errors = validatePost(parsed);
    if (errors.length) throw new Error(`초안 형식 오류: ${errors.join(' / ')}`);
    // 이미지가 필요한데 아직 준비 안 됐으면 지금 준비
    if (parsed.meta.imageQueries.length && !listPreparedImages(draftName).length) {
      log('이미지가 준비되지 않아 먼저 다운로드합니다...');
      await prepareImages({ draftName, imageQueries: parsed.meta.imageQueries, log });
    }
    const { url } = await publishPost({
      draftName,
      parsed,
      sourceUrls: extractSources(content),
      log,
    });
    return { url };
  });
  res.json({ jobId: job.id });
});

// ---------- 원클릭 자동 생성: 키워드 여러 개 → 수집 → 생성 → 대기열 적재 ----------
app.post('/api/auto-generate', (req, res) => {
  const { keywords = [], sources = ['news', 'blog'], maxItems = 4, instruction = '', clinic = {} } = req.body || {};
  const list = (Array.isArray(keywords) ? keywords : String(keywords).split(','))
    .map((k) => String(k).trim())
    .filter(Boolean)
    .slice(0, 10);
  if (!list.length) return res.status(400).json({ error: '키워드를 하나 이상 입력해 주세요.' });

  const srcList = (Array.isArray(sources) ? sources : []).filter((s) => ['news', 'blog'].includes(s));
  const cleanClinic = {
    name: String(clinic.name || '').trim(),
    doctor: String(clinic.doctor || '').trim(),
    dept: String(clinic.dept || '').trim(),
    topic: String(clinic.topic || '').trim(),
  };

  const job = startJob('auto-generate', async (log) => {
    // 키워드당 5분씩 걸리는 작업이라, 시작 전에 세션부터 확인한다
    await assertSessionsAlive(log);
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const keyword = list[i];
      log(`═══ [${i + 1}/${list.length}] "${keyword}" 시작 ═══`);
      try {
        // 1) 수집
        log('[1/3] 글감 수집 중...');
        const crawled = await crawl({
          keyword,
          sources: srcList.length ? srcList : ['news', 'blog'],
          maxItems: Math.min(Math.max(Number(maxItems) || 4, 1), 15),
          log,
        });
        const crawlMd = toMarkdown({ keyword, ...crawled });
        const crawlFile = saveMd('crawls', `글감_${keyword}`, crawlMd);
        log(`[1/3] 완료 — 뉴스 ${crawled.news.length} · 블로그 ${crawled.blogs.length} (${crawlFile})`);

        // 2) 생성
        log('[2/3] AI 글 생성 중...');
        const { parsed } = await generatePost({
          crawlContent: crawlMd,
          instruction: String(instruction).trim(),
          clinic: cleanClinic,
          log,
        });
        const draftText = withSources(serializePost(parsed), extractCrawlUrls(crawlMd));
        const draftName = saveMd('drafts', `초안_${keyword}`, draftText);
        log(`[2/3] 완료 — "${parsed.meta.title}" (${draftName})`);

        // 3) 이미지 준비 + 대기열 적재
        if (parsed.meta.imageQueries.length) {
          log('[3/3] 이미지 준비 중...');
          await prepareImages({ draftName, imageQueries: parsed.meta.imageQueries, log });
        }
        addItem({ draftName, title: parsed.meta.title });
        log(`[3/3] ✅ 대기열에 추가됨`);
        results.push({ keyword, draftName, title: parsed.meta.title, ok: true });
      } catch (e) {
        log(`⚠ "${keyword}" 실패: ${e.message}`);
        results.push({ keyword, ok: false, error: e.message });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    log(`총 ${okCount}/${list.length}개 초안이 대기열에 준비됐습니다. "자동 발행 시작"을 누르면 순서대로 발행됩니다.`);
    return { results, okCount };
  });
  res.json({ jobId: job.id });
});

// ---------- 자동 발행 대기열 ----------
app.get('/api/queue', (req, res) => res.json(getQueue()));

app.post('/api/queue', (req, res) => {
  const { draftName } = req.body || {};
  if (!draftName) return res.status(400).json({ error: '대기열에 추가할 초안을 선택해 주세요.' });
  try {
    const content = readMd('drafts', draftName);
    const parsed = parsePost(content);
    const errors = validatePost(parsed);
    if (errors.length) return res.status(400).json({ error: `초안 형식 오류: ${errors.join(' / ')}` });
    const item = addItem({ draftName, title: parsed.meta.title });
    res.json({ ok: true, id: item.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/queue/:id', (req, res) => {
  try {
    removeItem(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/queue/clear-finished', (req, res) => {
  clearFinished();
  res.json({ ok: true });
});

app.post('/api/queue/retry', (req, res) => {
  try {
    const count = retryItems(req.body?.id);
    res.json({ ok: true, count });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/queue/start', (req, res) => {
  try {
    startQueue(req.body?.intervalMin);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/queue/stop', (req, res) => {
  stopQueue();
  res.json({ ok: true });
});

// ---------- 중복 방지 ----------
app.get('/api/topics-status', (req, res) => res.json(topicsStatus()));

app.post('/api/topics-reset', (req, res) => {
  resetTopics();
  res.json({ ok: true, ...topicsStatus() });
});

// ---------- 파일 보관함 ----------
app.get('/api/files', (req, res) => {
  const { type } = req.query;
  try {
    res.json(listMd(type));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/file', (req, res) => {
  const { type, name } = req.query;
  try {
    res.json({ name, content: readMd(type, name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/file', (req, res) => {
  const { type, name } = req.query;
  try {
    deleteMd(type, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ 네이버 블로그 자동화 실행 중: http://localhost:${PORT}\n`);
  const cfg = loadConfig();
  if (!cfg.pexelsKey && !cfg.pixabayKey) {
    console.log('ℹ 이미지 API 키가 없어 무료 소스(Openverse/LoremFlickr)로 이미지를 찾습니다. 품질을 높이려면 설정 탭에서 Pexels 무료 키를 등록하세요.\n');
  }
});
