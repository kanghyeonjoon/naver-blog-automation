const $ = (id) => document.getElementById(id);

// ---------- 토스트 알림 (alert/confirm 팝업이 차단되는 환경 대응) ----------
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
let toastTimer;
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ''), 6000);
}

// ---------- 탭 전환 ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'settings') { loadConfig(); loadPersona(); refreshClipartSession(); }
    if (tab.dataset.tab === 'crawl' && !keywordsLoaded) loadKeywordOptions();
    if (tab.dataset.tab === 'generate') loadFileOptions('crawls', 'generateSource');
    if (tab.dataset.tab === 'review') loadDraftOptions();
    if (tab.dataset.tab === 'queue') { refreshQueue(); loadFileList(); refreshTopics(); }
  });
});

// ---------- 공통: 잡 폴링 ----------
async function pollJob(jobId, { logEl, onDone, onError }) {
  let lastLogCount = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, 1500));
    let job;
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      job = await res.json();
    } catch {
      continue;
    }
    if (logEl && job.logs.length > lastLogCount) {
      for (const l of job.logs.slice(lastLogCount)) {
        logEl.textContent += `[${new Date(l.t).toLocaleTimeString('ko-KR')}] ${l.msg}\n`;
      }
      logEl.scrollTop = logEl.scrollHeight;
      lastLogCount = job.logs.length;
    }
    if (job.status === 'done') return onDone && onDone(job.result);
    if (job.status === 'error') return onError ? onError(job.error) : showToast(`오류: ${job.error}`, true);
  }
}

function resetLog(el) {
  el.textContent = '';
  el.classList.remove('hidden');
}

async function postJson(url, body, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '요청 실패');
  return data;
}

// ---------- 로그인 세션 ----------
async function refreshSession() {
  try {
    const res = await fetch('/api/session');
    const info = await res.json();
    const badge = $('sessionStatus');
    if (info.exists) {
      badge.textContent = `✔ 세션 저장됨 (${new Date(info.savedAt).toLocaleString('ko-KR')})`;
      badge.className = 'badge ok';
    } else {
      badge.textContent = '✖ 로그인 세션 없음';
      badge.className = 'badge no';
    }
  } catch { /* 무시 */ }
}

$('loginBtn').addEventListener('click', async () => {
  $('loginBtn').disabled = true;
  $('sessionStatus').textContent = '브라우저에서 로그인해 주세요...';
  $('sessionStatus').className = 'badge';
  try {
    const { jobId } = await postJson('/api/login');
    await pollJob(jobId, {
      onDone: () => { showToast('네이버 로그인 세션이 저장되었습니다.'); refreshSession(); },
      onError: (e) => { showToast(e, true); refreshSession(); },
    });
  } catch (e) {
    showToast(e.message, true);
  } finally {
    $('loginBtn').disabled = false;
  }
});

// ---------- 세션 점검 (발행 전에 미리 확인) ----------
$('sessionCheckBtn').addEventListener('click', async () => {
  const btn = $('sessionCheckBtn');
  btn.disabled = true;
  btn.textContent = '확인 중...';
  try {
    const r = await (await fetch('/api/session-check')).json();
    const msg = [
      `네이버: ${r.naver.ok ? '✅ 정상' : '❌ ' + r.naver.reason}`,
      `클립아트: ${r.clipart.ok ? '✅ 정상' : '❌ ' + r.clipart.reason}`,
    ].join('  /  ');
    showToast(msg, !(r.naver.ok && r.clipart.ok));
  } catch (e) {
    showToast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 세션 점검';
  }
});

// ---------- 클립아트코리아 세션 ----------
async function refreshClipartSession() {
  try {
    const info = await (await fetch('/api/clipart-session')).json();
    const badge = $('clipartStatus');
    if (info.exists) {
      badge.textContent = `✔ 세션 저장됨 (${new Date(info.savedAt).toLocaleString('ko-KR')})`;
      badge.className = 'badge ok';
    } else {
      badge.textContent = '✖ 세션 없음';
      badge.className = 'badge no';
    }
  } catch { /* 무시 */ }
}

$('clipartLoginBtn').addEventListener('click', async () => {
  $('clipartLoginBtn').disabled = true;
  $('clipartStatus').textContent = '브라우저에서 로그인해 주세요...';
  $('clipartStatus').className = 'badge';
  try {
    const { jobId } = await postJson('/api/clipart-login');
    await pollJob(jobId, {
      onDone: () => { showToast('클립아트코리아 세션이 저장되었습니다.'); refreshClipartSession(); },
      onError: (e) => { showToast(e, true); refreshClipartSession(); },
    });
  } catch (e) {
    showToast(e.message, true);
  } finally {
    $('clipartLoginBtn').disabled = false;
  }
});

// ---------- ⚙ 설정 ----------
async function loadConfig() {
  try {
    const c = await (await fetch('/api/config')).json();
    $('cfgCategory').value = c.category || '';
    $('cfgVisibility').value = c.visibility || '전체공개';
    $('cfgHeadingStyle').value = c.headingStyle || 'corner';
    $('cfgPexels').value = c.pexelsKey || '';
    $('cfgPixabay').value = c.pixabayKey || '';
  } catch { /* 무시 */ }
}

$('cfgSaveBtn').addEventListener('click', async () => {
  try {
    await postJson('/api/config', {
      category: $('cfgCategory').value,
      visibility: $('cfgVisibility').value,
      headingStyle: $('cfgHeadingStyle').value,
      pexelsKey: $('cfgPexels').value,
      pixabayKey: $('cfgPixabay').value,
    });
    showToast('설정이 저장되었습니다.');
    loadConfig();
  } catch (e) {
    showToast(e.message, true);
  }
});

async function loadPersona() {
  try {
    const p = await (await fetch('/api/persona')).json();
    const ul = $('personaList');
    ul.innerHTML = '';
    if (!p.files || !p.files.length) {
      $('personaHint').innerHTML = `아직 스타일 가이드가 없습니다. 아래 폴더에 PDF 또는 md 파일을 넣으면 글 생성 시 자동으로 그 문체를 따라 씁니다.<br/><code>${p.dir || 'data/persona'}</code>`;
      return;
    }
    $('personaHint').innerHTML = `아래 파일이 글 생성 시 문체 기준으로 적용됩니다. 교체하려면 폴더의 파일을 바꾸면 됩니다.<br/><code>${p.dir}</code>`;
    for (const f of p.files) {
      const li = document.createElement('li');
      li.innerHTML = `${f.name}<span class="meta">${(f.size / 1024).toFixed(1)}KB · ${new Date(f.mtime).toLocaleString('ko-KR')}</span>`;
      ul.appendChild(li);
    }
  } catch { /* 무시 */ }
}

// ---------- ① 글감 수집 ----------
let keywordsLoaded = false;

async function loadKeywordOptions() {
  try {
    const { keywords } = await (await fetch('/api/keywords')).json();
    const sel = $('keywordSelect');
    sel.innerHTML = '<option value="">(직접 입력)</option>';
    for (const kw of keywords) {
      const opt = document.createElement('option');
      opt.value = kw;
      opt.textContent = kw;
      sel.appendChild(opt);
    }
    keywordsLoaded = keywords.length > 0;
    if (!keywords.length) sel.innerHTML = '<option value="">(저장된 키워드 없음)</option>';
  } catch { /* 무시 */ }
}

$('keywordSelect').addEventListener('change', () => {
  if ($('keywordSelect').value) $('keyword').value = $('keywordSelect').value;
});

$('keywordRandomBtn').addEventListener('click', () => {
  const sel = $('keywordSelect');
  const options = [...sel.options].filter((o) => o.value);
  if (!options.length) return showToast('저장된 키워드가 없습니다.', true);
  const pick = options[Math.floor(Math.random() * options.length)];
  sel.value = pick.value;
  $('keyword').value = pick.value;
  showToast(`키워드 선택됨: ${pick.value}`);
});

$('crawlBtn').addEventListener('click', async () => {
  const keyword = $('keyword').value.trim();
  if (!keyword) return showToast('키워드를 입력해 주세요.', true);
  const sources = [];
  if ($('srcNews').checked) sources.push('news');
  if ($('srcBlog').checked) sources.push('blog');
  if (!sources.length) return showToast('뉴스/블로그 중 하나 이상을 선택해 주세요.', true);
  $('crawlBtn').disabled = true;
  $('crawlResult').classList.add('hidden');
  resetLog($('crawlLog'));
  try {
    const { jobId } = await postJson('/api/crawl', { keyword, sources, maxItems: $('maxItems').value });
    await pollJob(jobId, {
      logEl: $('crawlLog'),
      onDone: (result) => {
        $('crawlResultFile').textContent = result.fileName;
        $('crawlResultContent').textContent = result.content;
        $('crawlResult').classList.remove('hidden');
        $('crawlBtn').disabled = false;
      },
      onError: (e) => { showToast(`수집 오류: ${e}`, true); $('crawlBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('crawlBtn').disabled = false;
  }
});

// ---------- 파일 옵션 로드 ----------
async function loadFileOptions(type, selectId) {
  const res = await fetch(`/api/files?type=${type}`);
  const files = await res.json();
  const sel = $(selectId);
  sel.innerHTML = '';
  if (!files.length) {
    sel.innerHTML = '<option value="">(파일 없음)</option>';
    return;
  }
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = f.name;
    sel.appendChild(opt);
  }
}

// ---------- ② 글 생성 ----------
let lastDraftName = null;

$('generateBtn').addEventListener('click', async () => {
  const crawlFile = $('generateSource').value;
  if (!crawlFile) return showToast('글감 파일을 먼저 만들어 주세요 (① 글감 수집).', true);
  $('generateBtn').disabled = true;
  $('generateResult').classList.add('hidden');
  resetLog($('generateLog'));
  $('generateLog').textContent = 'AI 글 생성 요청 중... (수 분이 걸릴 수 있습니다)\n';
  try {
    const clinic = {
      name: $('clinicName').value.trim(),
      doctor: $('clinicDoctor').value.trim(),
      dept: $('clinicDept').value.trim(),
      topic: $('clinicTopic').value.trim(),
    };
    // 다음에도 같은 병원으로 쓰는 경우가 많아 값을 기억해 둔다
    localStorage.setItem('blog_clinic', JSON.stringify(clinic));
    const { jobId } = await postJson('/api/generate', {
      crawlFile,
      instruction: $('instruction').value.trim(),
      clinic,
    });
    await pollJob(jobId, {
      logEl: $('generateLog'),
      onDone: (result) => {
        lastDraftName = result.fileName;
        $('generateResultFile').textContent = result.fileName;
        $('generateResultContent').textContent = result.content;
        $('generateResult').classList.remove('hidden');
        $('generateBtn').disabled = false;
        showToast(`✅ 초안 생성 완료: "${result.title}"`);
      },
      onError: (e) => { showToast(`생성 오류: ${e}`, true); $('generateBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('generateBtn').disabled = false;
  }
});

$('goReviewBtn').addEventListener('click', async () => {
  document.querySelector('.tab[data-tab="review"]').click();
  if (lastDraftName) {
    await loadDraftOptions();
    $('draftSelect').value = lastDraftName;
    loadDraft();
  }
});

// ---------- ③ 검토 · 발행 ----------
let currentDraft = null;

async function loadDraftOptions() {
  const res = await fetch('/api/drafts');
  const files = await res.json();
  const sel = $('draftSelect');
  sel.innerHTML = '';
  if (!files.length) {
    sel.innerHTML = '<option value="">(초안 없음 — ② 탭에서 생성)</option>';
    return;
  }
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = f.name;
    sel.appendChild(opt);
  }
}

async function loadDraft() {
  const name = $('draftSelect').value;
  if (!name) return showToast('초안을 선택해 주세요.', true);
  try {
    const res = await fetch(`/api/draft?name=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentDraft = name;
    $('draftContent').value = data.content;
    $('draftEditor').classList.remove('hidden');
    renderImagePreviews(data.images || []);
    if (data.parseError) showToast(`⚠ 형식 오류: ${data.parseError}`, true);
  } catch (e) {
    showToast(e.message, true);
  }
}

$('draftLoadBtn').addEventListener('click', loadDraft);

function renderImagePreviews(images) {
  const box = $('imagesPreview');
  box.innerHTML = '';
  for (const im of images) {
    const img = document.createElement('img');
    img.src = `/api/draft-image?name=${encodeURIComponent(currentDraft)}&index=${im.index}&t=${Date.now()}`;
    img.title = `이미지 ${im.index}`;
    box.appendChild(img);
  }
}

$('draftSaveBtn').addEventListener('click', async () => {
  if (!currentDraft) return;
  try {
    const r = await postJson('/api/draft', { name: currentDraft, content: $('draftContent').value }, 'PUT');
    if (r.warnings && r.warnings.length) showToast(`저장됨 — 경고: ${r.warnings.join(' / ')}`, true);
    else showToast('초안이 저장되었습니다.');
  } catch (e) {
    showToast(e.message, true);
  }
});

$('imagesPrepareBtn').addEventListener('click', async () => {
  if (!currentDraft) return;
  $('imagesPrepareBtn').disabled = true;
  resetLog($('reviewLog'));
  try {
    const { jobId } = await postJson('/api/images/prepare', { draftName: currentDraft });
    await pollJob(jobId, {
      logEl: $('reviewLog'),
      onDone: async () => {
        $('imagesPrepareBtn').disabled = false;
        const data = await (await fetch(`/api/draft?name=${encodeURIComponent(currentDraft)}`)).json();
        renderImagePreviews(data.images || []);
        showToast('이미지 준비가 끝났습니다. 아래 미리보기를 확인하세요.');
      },
      onError: (e) => { showToast(`이미지 오류: ${e}`, true); $('imagesPrepareBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('imagesPrepareBtn').disabled = false;
  }
});

// 팝업(confirm)이 차단되는 환경이 있어, 버튼을 두 번 눌러 확인하는 방식 사용
let publishArmed = false;
let publishArmTimer;

function resetPublishBtn() {
  publishArmed = false;
  clearTimeout(publishArmTimer);
  $('publishBtn').textContent = '네이버 블로그에 발행';
}

$('publishBtn').addEventListener('click', async () => {
  if (!currentDraft) return showToast('초안을 먼저 불러와 주세요.', true);

  if (!publishArmed) {
    publishArmed = true;
    $('publishBtn').textContent = '⚠ 정말 발행할까요? 한 번 더 클릭 (8초 내)';
    showToast('발행 확인: 저장된 초안이 네이버 블로그에 발행됩니다. 수정했다면 먼저 "수정 저장"을 누르세요.');
    publishArmTimer = setTimeout(resetPublishBtn, 8000);
    return;
  }

  resetPublishBtn();
  $('publishBtn').disabled = true;
  resetLog($('reviewLog'));
  try {
    const { jobId } = await postJson('/api/publish', { draftName: currentDraft });
    await pollJob(jobId, {
      logEl: $('reviewLog'),
      onDone: (result) => {
        showToast(`✅ 발행 완료! ${result.url || ''}`);
        $('publishBtn').disabled = false;
      },
      onError: (e) => { showToast(`발행 오류: ${e}`, true); $('publishBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('publishBtn').disabled = false;
  }
});

$('addQueueBtn').addEventListener('click', async () => {
  if (!currentDraft) return showToast('초안을 먼저 불러와 주세요.', true);
  try {
    await postJson('/api/queue', { draftName: currentDraft });
    showToast('대기열에 추가되었습니다. ⏱ 대기열 탭에서 자동 발행을 시작하세요.');
  } catch (e) {
    showToast(e.message, true);
  }
});

// ---------- 🤖 원클릭 자동 생성 ----------
$('autoKeywordFillBtn').addEventListener('click', async () => {
  try {
    const { keywords } = await (await fetch('/api/keywords')).json();
    if (!keywords.length) return showToast('저장된 키워드가 없습니다.', true);
    const picked = [];
    const pool = [...keywords];
    while (picked.length < 3 && pool.length) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    $('autoKeywords').value = picked.join(', ');
    showToast(`키워드 ${picked.length}개를 채웠습니다.`);
  } catch (e) {
    showToast(e.message, true);
  }
});

$('autoGenBtn').addEventListener('click', async () => {
  const raw = $('autoKeywords').value.trim();
  if (!raw) return showToast('키워드를 입력해 주세요.', true);
  const keywords = raw.split(',').map((k) => k.trim()).filter(Boolean);

  $('autoGenBtn').disabled = true;
  resetLog($('autoGenLog'));
  $('autoGenLog').textContent = `${keywords.length}개 키워드로 자동 생성을 시작합니다. 키워드당 5분 내외 걸립니다.\n`;
  try {
    const { jobId } = await postJson('/api/auto-generate', {
      keywords,
      sources: ['news', 'blog'],
      maxItems: $('autoMaxItems').value,
      instruction: $('autoInstruction').value.trim(),
      // ② 탭에 병원 정보가 채워져 있으면 병원 명의 원고로 생성
      clinic: {
        name: $('clinicName').value.trim(),
        doctor: $('clinicDoctor').value.trim(),
        dept: $('clinicDept').value.trim(),
        topic: $('clinicTopic').value.trim(),
      },
    });
    await pollJob(jobId, {
      logEl: $('autoGenLog'),
      onDone: (result) => {
        showToast(`✅ ${result.okCount}개 초안이 대기열에 준비됐습니다.`);
        $('autoGenBtn').disabled = false;
        refreshQueue();
        loadDraftOptions();
      },
      onError: (e) => { showToast(`자동 생성 오류: ${e}`, true); $('autoGenBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('autoGenBtn').disabled = false;
  }
});

// ---------- ⏱ 대기열 ----------
const STATUS_LABEL = {
  pending: '⏳ 대기 중',
  publishing: '🚀 발행 중...',
  done: '✅ 발행 완료',
  failed: '❌ 실패',
};

let queueTimer = null;
let intervalSynced = false; // 발행 간격 입력값을 서버 값으로 채웠는지 (최초 1회만)
let previewDraft = null;    // 대기열에서 미리보기 중인 초안

/** 대기열 항목의 글 내용을 펼쳐 보여준다 (같은 항목을 다시 누르면 닫힘) */
async function showQueuePreview(draftName, title) {
  if (previewDraft === draftName) {
    previewDraft = null;
    $('queuePreview').classList.add('hidden');
    refreshQueue();
    return;
  }
  try {
    const res = await fetch(`/api/draft?name=${encodeURIComponent(draftName)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    previewDraft = draftName;
    $('queuePreviewTitle').textContent = title || draftName;
    // 마커는 그대로 두되 출처 섹션은 잘라서 본문만 보이게
    $('queuePreviewContent').textContent = String(data.content).split('===SOURCES===')[0].trim();
    $('queuePreview').classList.remove('hidden');
    refreshQueue();
  } catch (e) {
    showToast(e.message, true);
  }
}

$('queuePreviewCloseBtn').addEventListener('click', () => {
  previewDraft = null;
  $('queuePreview').classList.add('hidden');
  refreshQueue();
});

$('queuePreviewEditBtn').addEventListener('click', async () => {
  if (!previewDraft) return;
  const name = previewDraft;
  document.querySelector('.tab[data-tab="review"]').click();
  await loadDraftOptions();
  $('draftSelect').value = name;
  loadDraft();
});

async function refreshQueue() {
  let q;
  try {
    const res = await fetch('/api/queue');
    q = await res.json();
  } catch {
    return;
  }

  const pending = q.items.filter((i) => i.status === 'pending').length;
  let status = q.running
    ? `🟢 자동 발행 실행 중 — ${q.intervalMin}분 간격, 대기 ${pending}개`
    : `⚪ 중지됨 — 대기 ${pending}개`;
  if (q.running && q.nextAt) {
    const remainMs = q.nextAt - Date.now();
    if (remainMs > 0) {
      const m = Math.floor(remainMs / 60000);
      const s = Math.floor((remainMs % 60000) / 1000);
      status += ` · 다음 발행까지 ${m}분 ${s}초`;
    }
  }
  $('queueStatus').textContent = status;
  $('queueStartBtn').classList.toggle('hidden', q.running);
  $('queueStopBtn').classList.toggle('hidden', !q.running);
  // 대기열 화면은 3초마다 갱신되는데, 그때마다 서버 값으로 덮어쓰면
  // 사용자가 입력 중인 간격이 되돌아가 버린다 → 첫 로드와 실행 중일 때만 동기화
  const intervalEl = $('queueInterval');
  const editing = document.activeElement === intervalEl;
  if (!intervalSynced || (q.running && !editing)) {
    intervalEl.value = q.intervalMin;
    intervalSynced = true;
  }

  const ul = $('queueList');
  ul.innerHTML = '';
  if (!q.items.length) {
    ul.innerHTML = '<li class="empty">대기열이 비어 있습니다. ③ 탭에서 초안을 추가하세요.</li>';
  }
  for (const item of q.items) {
    const li = document.createElement('li');
    const extra = [];
    if (item.url) extra.push(item.url);
    if (item.error) extra.push(item.error.slice(0, 80));
    li.innerHTML = `${STATUS_LABEL[item.status] || item.status} · ${item.title}<span class="meta">${extra.join(' · ')}</span>`;
    if (item.draftName === previewDraft) li.classList.add('selected');
    // 항목을 클릭하면 어떤 글인지 내용을 펼쳐 볼 수 있게
    li.addEventListener('click', () => showQueuePreview(item.draftName, item.title));
    if (item.status !== 'publishing') {
      const del = document.createElement('button');
      del.className = 'btn secondary small';
      del.textContent = '삭제';
      del.style.marginLeft = '8px';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/queue/${item.id}`, { method: 'DELETE' });
        refreshQueue();
      });
      li.appendChild(del);
    }
    ul.appendChild(li);
  }

  const logEl = $('queueLog');
  logEl.textContent = (q.logs || [])
    .map((l) => `[${new Date(l.t).toLocaleTimeString('ko-KR')}] ${l.msg}`)
    .join('\n');
  logEl.scrollTop = logEl.scrollHeight;

  clearTimeout(queueTimer);
  if ($('tab-queue').classList.contains('active')) {
    queueTimer = setTimeout(refreshQueue, 3000);
  }
}

// 간격이 너무 짧으면 네이버 어뷰징 판정 위험 → 한 번 더 확인
let shortIntervalArmed = false;
let shortIntervalTimer;

$('queueStartBtn').addEventListener('click', async () => {
  const interval = Number($('queueInterval').value) || 0;
  if (interval < 30 && !shortIntervalArmed) {
    shortIntervalArmed = true;
    $('queueStartBtn').textContent = `⚠ ${interval}분 간격입니다. 정말 시작할까요? (한 번 더 클릭)`;
    showToast(`발행 간격이 ${interval}분으로 너무 짧습니다. 연속 발행은 네이버 어뷰징 판정 위험이 있어 60분 이상을 권합니다.`, true);
    shortIntervalTimer = setTimeout(() => {
      shortIntervalArmed = false;
      $('queueStartBtn').textContent = '▶ 자동 발행 시작';
    }, 8000);
    return;
  }
  shortIntervalArmed = false;
  clearTimeout(shortIntervalTimer);
  $('queueStartBtn').textContent = '▶ 자동 발행 시작';

  try {
    await postJson('/api/queue/start', { intervalMin: $('queueInterval').value });
    showToast('자동 발행이 시작되었습니다. 첫 글은 곧 발행됩니다.');
    refreshQueue();
  } catch (e) {
    showToast(e.message, true);
  }
});

$('queueStopBtn').addEventListener('click', async () => {
  await postJson('/api/queue/stop');
  showToast('자동 발행이 중지되었습니다.');
  refreshQueue();
});

$('queueRetryBtn').addEventListener('click', async () => {
  try {
    const r = await postJson('/api/queue/retry', {});
    showToast(`실패 항목 ${r.count}개를 대기 상태로 되돌렸습니다. "자동 발행 시작"을 누르세요.`);
    refreshQueue();
  } catch (e) {
    showToast(e.message, true);
  }
});

$('queueClearBtn').addEventListener('click', async () => {
  await postJson('/api/queue/clear-finished');
  refreshQueue();
});

// ---------- 중복 방지 ----------
async function refreshTopics() {
  try {
    const s = await (await fetch('/api/topics-status')).json();
    $('topicsStatusLabel').textContent = `(발행 기록 ${s.total}건 — 같은 소재·주제 중복 방지에 사용)`;
  } catch { /* 무시 */ }
}

let topicsResetArmed = false;
let topicsResetTimer;
$('topicsResetBtn').addEventListener('click', async () => {
  if (!topicsResetArmed) {
    topicsResetArmed = true;
    $('topicsResetBtn').textContent = '한 번 더 클릭하면 초기화';
    topicsResetTimer = setTimeout(() => {
      topicsResetArmed = false;
      $('topicsResetBtn').textContent = '발행 기록(중복 방지) 초기화';
    }, 5000);
    return;
  }
  topicsResetArmed = false;
  clearTimeout(topicsResetTimer);
  $('topicsResetBtn').textContent = '발행 기록(중복 방지) 초기화';
  await postJson('/api/topics-reset');
  showToast('발행 기록이 초기화되었습니다.');
  refreshTopics();
});

// ---------- 파일 보관함 ----------
let selectedFile = null;

async function loadFileList() {
  const type = $('fileType').value;
  const res = await fetch(`/api/files?type=${type}`);
  const files = await res.json();
  const ul = $('fileList');
  ul.innerHTML = '';
  selectedFile = null;
  $('fileViewName').textContent = '';
  $('fileViewContent').textContent = '파일을 선택하세요.';
  $('deleteFileBtn').classList.add('hidden');
  if (!files.length) {
    ul.innerHTML = '<li class="empty">파일이 없습니다.</li>';
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = `${f.name}<span class="meta">${new Date(f.mtime).toLocaleString('ko-KR')} · ${(f.size / 1024).toFixed(1)}KB</span>`;
    li.addEventListener('click', async () => {
      ul.querySelectorAll('li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      const r = await fetch(`/api/file?type=${type}&name=${encodeURIComponent(f.name)}`);
      const data = await r.json();
      selectedFile = { type, name: f.name };
      $('fileViewName').textContent = f.name;
      $('fileViewContent').textContent = data.content || data.error;
      $('deleteFileBtn').classList.remove('hidden');
    });
    ul.appendChild(li);
  }
}

$('fileType').addEventListener('change', loadFileList);
$('refreshFilesBtn').addEventListener('click', loadFileList);

let deleteArmed = false;
let deleteArmTimer;

$('deleteFileBtn').addEventListener('click', async () => {
  if (!selectedFile) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $('deleteFileBtn').textContent = '한 번 더 클릭하면 삭제';
    deleteArmTimer = setTimeout(() => {
      deleteArmed = false;
      $('deleteFileBtn').textContent = '삭제';
    }, 5000);
    return;
  }
  deleteArmed = false;
  clearTimeout(deleteArmTimer);
  $('deleteFileBtn').textContent = '삭제';
  await fetch(`/api/file?type=${selectedFile.type}&name=${encodeURIComponent(selectedFile.name)}`, { method: 'DELETE' });
  showToast('파일이 삭제되었습니다.');
  loadFileList();
});

// ---------- 초기화 ----------
try {
  const saved = JSON.parse(localStorage.getItem('blog_clinic') || '{}');
  if (saved.name !== undefined) $('clinicName').value = saved.name || '';
  if (saved.doctor !== undefined) $('clinicDoctor').value = saved.doctor || '';
  if (saved.dept !== undefined) $('clinicDept').value = saved.dept || '';
  if (saved.topic !== undefined) $('clinicTopic').value = saved.topic || '';
} catch { /* 무시 */ }

refreshSession();
refreshClipartSession();
loadConfig();
loadPersona();
loadKeywordOptions();
