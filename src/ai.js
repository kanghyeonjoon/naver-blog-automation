import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadPersona } from './persona.js';
import { parsePost, validatePost } from './post-format.js';
import { recentTitles } from './topics.js';
import { loadTitleExamples } from './keywords.js';

/**
 * Claude Agent SDK 호출.
 * 별도 API 키 없이 로컬에 로그인된 Claude 구독 계정(OAuth)을 사용한다.
 * (claude.ai 구독으로 Claude Code에 로그인되어 있어야 함)
 */
async function runClaude({ systemPrompt, prompt, log }) {
  let resultText = '';
  let assistantText = '';
  let stderrBuf = '';
  try {
    const q = query({
      prompt,
      options: {
        systemPrompt,
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        // 프롬프트(스타일가이드+규칙+글감+추가지시)가 길고 결과물도 3500자 이상이라
        // 한 턴에 못 끝내고 error_max_turns가 나는 경우가 잦다 → 넉넉히 둔다 (도구는 못 쓰므로 남용 위험 없음)
        maxTurns: 12,
        stderr: (data) => { stderrBuf += data; },
      },
    });
    try {
      for await (const message of q) {
        if (message.type === 'assistant') {
          log('AI 응답 생성 중...');
          // result 메시지가 유실될 경우를 대비해 assistant 텍스트도 수집
          const blocks = message.message?.content || [];
          for (const b of blocks) {
            if (b.type === 'text' && b.text) assistantText += b.text;
          }
        }
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            resultText = message.result;
          } else {
            throw new Error(`AI 실행 실패: ${message.subtype}`);
          }
        }
      }
    } catch (e) {
      // 응답을 이미 받은 뒤의 프로세스 종료 오류는 무시하고 결과를 사용
      const gotResponse = resultText || assistantText;
      if (!(gotResponse && /exited with code/i.test(String(e.message)))) throw e;
      log('⚠ 프로세스가 비정상 종료되었지만 응답은 수신됨 — 결과를 사용합니다.');
    }
  } catch (e) {
    const stderrTail = stderrBuf.trim().split('\n').slice(-5).join('\n');
    if (/auth|login|credential|401|403/i.test(String(e.message) + stderrBuf)) {
      throw new Error(
        'Claude 인증에 실패했습니다. 터미널에서 `claude` 를 실행해 `/login` 으로 구독 계정에 로그인해 주세요. ' +
          `(원인: ${e.message})`
      );
    }
    throw new Error(`${e.message}${stderrTail ? `\n[상세] ${stderrTail}` : ''}`);
  }
  if (!resultText && assistantText) resultText = assistantText;
  // 인증 오류는 subtype=success인 채로 결과 텍스트에 담겨 올 수 있음
  if (/API Error: 401|authentication_error|OAuth.+revoked|Please run \/login/i.test(resultText)) {
    throw new Error(
      'Claude 구독 계정 인증이 만료되었습니다. 터미널을 열고 `claude` 실행 후 `/login` 명령으로 다시 로그인해 주세요.'
    );
  }
  if (!resultText) throw new Error('AI가 빈 응답을 반환했습니다.');
  return resultText;
}

const FORMAT_SPEC = `반드시 아래 형식만 출력합니다. 형식 밖의 설명·주석·마크다운 코드펜스는 절대 넣지 않습니다.

===META===
title: (블로그 글 제목 — 아래 "제목 4법칙" 중 하나를 골라 적용. 매번 같은 패턴을 반복하지 말 것)
  · 의외성: 기존 통념을 깨는 제시 — "병원 유튜브 상위노출, 구독자보다 'OOOO'이 먼저입니다"
  · 구체성: 숫자·비율 제시 — "병원 관계자 98%가 모르는 전환 실패의 원인"
  · 신뢰성: 근거·권위 빌려오기 — "상위 0.1%만 아는", "실무자가 직접 밝힌"
  · 단순성: 직관적 단언·리스트 — "예약 환자 놓치는 실수 '3가지'"
  ※ "~는 되는데 ~가 없다면, ~하세요" 같은 한 가지 틀을 반복하지 마세요. 낚시성·과장 표현은 금지.
tags: (쉼표로 구분한 태그 5~10개, # 없이)
images: (본문 [IMG:n]에 쓸 한국어 이미지 검색어를 | 로 구분. 스톡 이미지 사이트에서 검색되므로 짧고 보편적인 3단어.
  **각 검색어에는 반드시 '병원·의료·진료·의사·간호사·환자' 중 하나를 포함**해야 합니다.
  이 단어가 없으면 전혀 다른 업종 사진이 들어옵니다.
  (실제 사고: "회의 상담"으로 검색했더니 한미정상회담 일러스트가, "스마트폰 리뷰 확인"으로
   검색했더니 아르바이트 최저시급 일러스트가 들어갔습니다.)
  **검색어를 서로 다르게** 쓰고, 각 단락 내용에 맞게 구체적으로 정합니다.
  좋은 예: 병원 진료실 상담 | 병원 접수 데스크 | 의사 환자 설명 | 간호사 병원 업무
  나쁜 예: 회의 상담 (업종 불명) / 스마트폰 확인 (업종 불명) / 데이터 분석 그래프 (업종 불명))
===BODY===
(본문. 아래 마커 사용:)
[H] 소제목 — 글의 큰 단락마다 사용. **한 줄, 25자 이내로 짧게** 씁니다 (상자 안에 한 줄로 들어가야 함). [H]를 두 번 연속 쓰지 않습니다.
[QUOTE] 문구 — 기울임+가운데 정렬로 표시됨 (독자 속마음 따옴표 질문, 섹션 전환 문구용). **한 줄에 들어가도록 25자 이내로 짧게** 씁니다 (길면 가운데 정렬에서 어정쩡하게 두 줄로 접힘)
[CASE] ... [/CASE] — 도입부 사례 박스. 여러 줄로 쓰며, 박스로 감싸져 표시됩니다 (병원 명의 원고에서만 사용)
[IMG:1] — 이미지 위치. 단독 줄로. images의 n번째 검색어와 대응 (2~4개 권장)
[HR] — 화제 전환 구분선 (선택)
**굵게** — 문장 안에서 정말 강조할 짧은 구절에만. 문장 전체를 감싸지 말고, 한 문단에 최대 1개. 굵게가 없는 문단이 더 많아야 합니다.
@@빨간 강조@@ — 빨간색+굵게. 글 전체에서 정말 중요한 핵심 문장 2~4곳에만 사용
%%파란 강조%% — 파란색+굵게. 이 글의 핵심 개념어·용어를 처음 제시할 때, 또는 독자(원장님·환자)의 목소리를 옮긴 따옴표 문장에 사용. 글 전체 3~6곳
==형광펜== — 노란 배경 강조. 독자가 꼭 기억해야 할 구절에 문단당 최대 1개
일반 문단은 마커 없이 씁니다. 문단 사이는 빈 줄로 구분합니다.
===END===`;

const COMMON_RULES = `작성 규칙:
- 수집된 자료는 "정보와 소재"로만 사용하고, 문장은 처음부터 새로 씁니다. 원문 문장을 그대로 옮기지 않습니다.
- 사실 정보(수치, 날짜, 정책 등)는 수집 자료에 있는 내용만 사용하고, 불확실하면 단정하지 않습니다. 경력·실적 숫자를 지어내지 않습니다.

근거 활용 (설득력의 핵심):
- 수집 자료에 "근거자료 (통계·조사)" 섹션이 있으면 **그 수치를 반드시 활용**합니다. 최소 1개는 도입부(첫 3문단 안)에 배치해 임팩트를 만듭니다.
- 수치를 쓸 때는 **출처를 함께 밝힙니다**: "OO 조사에 따르면", "OO청 자료를 보면"
- 숫자만 던지지 말고 **체감되도록 비유·환산**을 붙입니다. 예: "하루 100명이면, 진료 시간 8시간 기준 5분에 한 명꼴입니다."
- 근거자료가 없으면 억지로 수치를 만들지 말고, 대신 **구체적인 상황 묘사나 비유**로 임팩트를 냅니다. **절대 숫자를 지어내지 않습니다.**

지역 키워드가 포함된 주제일 때 (예: "부천 병원마케팅", "일산 치과마케팅"):
- 지역명은 검색 노출을 위한 키워드입니다. **글 내용은 해당 주제(병원마케팅·치과마케팅 등)의 정보를 충실히 전달**하는 것이 본질입니다.
- 지역명은 제목과 도입부, 본문에 자연스럽게 3~5회 넣되, **그 지역만의 특수한 사실을 지어내지 않습니다** (지역 병원 수, 지역 상권 분석 등을 근거 없이 쓰지 말 것).
- 지역에 대해 쓸 말이 없으면 지역 이야기를 늘리지 말고, 주제 자체의 실질적 정보로 채웁니다.

정보 밀도 (가장 중요 — 이 규칙을 어기면 글을 다시 써야 합니다):

1) **소제목 섹션마다 "실제로 어떻게 하는지"를 반드시 하나씩 넣습니다.** 아래 중 하나의 형태여야 합니다.
   · **바꾸기 전 / 바꾼 후 대비**
     바꾸기 전: "임플란트는 뼈에 인공치근을 심는 시술입니다"
     바꾼 후: "잇몸뼈가 부족하다는 말을 들으셨다면, 뼈이식을 함께 할지부터 확인하셔야 합니다. 이 경우 기간이 2~3개월 늘어납니다"
   · **그대로 쓸 수 있는 문구·문장 예시**
   · **점검 항목** (무엇을 어디서 어떤 순서로 확인하는지)

2) **"~해야 합니다"로 끝나는 문단 뒤에는 반드시 "어떻게" 문단이 옵니다.**
   "환자의 고민에 답을 주는 글로 바뀌어야 합니다"만 쓰고 넘어가면 안 됩니다. 바로 다음 문단에서 그 방법을 씁니다.

3) **다른 업종 사례는 인용하지 않습니다.** 수집 자료에 화장품·쇼핑몰·요식업 등 병원이 아닌 사례가 있어도 가져오지 않습니다.
   (억지로 "병원도 마찬가지입니다"로 연결하면 글의 흐름이 끊기고 설득력이 떨어집니다.)
   병원·의료 분야 사례와 수치만 활용합니다.

4) 근거 없는 성과 단언 금지: "그렇게 바꾼 병원들은 전환율이 달라지는 걸 체감합니다" 같은 문장은 쓰지 않습니다.

5) 다음 문장들은 **절대 쓰지 않습니다**(읽고 나서 남는 게 없음):
   "환자는 생활권 단위로 검색합니다" / "요즘은 온라인 마케팅이 중요합니다" / "꾸준히 관리하는 것이 중요합니다" /
   "환자 입장에서 생각해야 합니다" / "신뢰가 무엇보다 중요합니다" / "전략적인 접근이 필요합니다"

6) 글을 끝낸 뒤 스스로 점검합니다: **각 섹션에서 원장님이 오늘 당장 할 수 있는 일이 하나씩 나오는가?**
   안 나오는 섹션은 그 자리에 구체적인 방법을 채워 넣습니다.

7) 주제에서 벗어난 섹션(분량 채우기)은 넣지 않습니다. 소제목이 제목의 질문에 답하는 데 기여하지 않으면 삭제합니다.
- 글쓰기 스타일 가이드가 제공되면 그 구조와 문체를 **반드시 그대로** 따릅니다.
- 이미 발행한 제목 목록이 제공되면 그 주제·제목과 겹치지 않게 씁니다.
- 의료광고법을 준수합니다. 최고·1등·100%·완치·부작용 없음 같은 표현을 쓰지 않고, 효과를 단정하지 않습니다.`;

// ① 몽PD 칼럼 (원장님 대상 B2B) — 짧게 끊어 쓰는 리듬
const COLUMN_SYSTEM = `당신은 네이버 블로그 전문 작가입니다.
제공된 글감을 바탕으로 병원 원장님을 독자로 하는 마케팅 칼럼을 씁니다.

${COMMON_RULES}

문장 배치 규칙 (네이버 블로그 모바일 가독성):
- **한 문단 = 한 문장**이 원칙입니다. 마침표로 문장이 끝나면 문단을 나눕니다(빈 줄).
- 문장 자체는 잘게 끊지 않고 완결된 형태로 자연스럽게 씁니다.
- 예외: 아주 짧은 문장("이유는 간단합니다.")은 바로 뒤 문장과 한 문단으로 묶어도 됩니다. 한 문단이 2문장을 넘지 않습니다.
- 예시:

상담실장이 바뀐 뒤로 문의는 비슷하게 들어오는데 예약률이 떨어지고, 예약은 잡히는데 정작 내원으로 이어지지 않는 경우가 있습니다.

이럴 때 많은 원장님들은 먼저 광고를 의심하십니다.

하지만 실제로는 문의를 받는 방식과 상담 흐름에서 원인을 찾아야 하는 경우가 더 많습니다.

${FORMAT_SPEC}`;

// ② 병원 명의 원고 (환자 대상) — 완결된 문장으로 자연스럽게 이어 쓰는 설명체
const CLINIC_SYSTEM = `당신은 병원 원장님을 대신해 환자에게 설명하는 의료 콘텐츠 작가입니다.
지정된 병원의 원장님이 직접 쓴 것처럼, 해당 시술·치료를 고민하는 환자를 독자로 글을 씁니다.

${COMMON_RULES}

문장 배치 규칙 (매우 중요):
- **한 문단 = 한 문장**이 원칙입니다. 마침표로 문장이 끝나면 문단을 나눕니다(빈 줄).
- 문장 자체는 잘게 끊지 않고 완결된 형태로 자연스럽게 씁니다.
- 예외: 아주 짧은 문장은 바로 뒤 문장과 묶어도 됩니다. 한 문단이 2문장을 넘지 않습니다.
- 예시:

자연유착 쌍꺼풀은 흉터, 회복기간에 대한 부담이 적고, 기존 매몰법보다 더 견고한 쌍꺼풀을 만들어 줄 수 있는 수술법이라는 점에서 많은 분들의 관심을 받고 있는데요.

하지만 '풀리지 않는다'는 말만 믿고 수술을 결정하는 것은 권해드리지 않습니다.

사람마다 눈꺼풀의 두께, 눈뜨는 힘, 지방량 같은 조건이 다르고, 같은 수술도 개인의 눈 상태에 따라 결과가 달라지기 때문입니다.

- 좋은 점만 나열하지 않습니다. 한계와 "모두에게 적합하지는 않다"는 점을 반드시 함께 밝힙니다.
- 적응증/비적응증 등 항목 나열은 ▶ 기호로 씁니다: **▶ 피부가 얇고 지방층이 적은 경우**
  (별표(*)는 굵게 표시와 충돌하므로 항목 기호로 쓰지 않습니다)

제목 공식 (병원 명의 원고):
\`[지역·역명 + 진료과 또는 질환 키워드] + [후킹]\`
- 앞부분에 검색 키워드를 배치하고, 핵심어는 '작은따옴표'로 감쌉니다.
- 후킹은 매번 다른 유형으로: 숫자·비율형 / 단정·필독형 / 의문형 반전 / 전문가 답변형
- 예: 「도곡동정형외과 '허리디스크' 95%의 비밀?」 「선릉역 허리디스크 수술 없이 치료하고 싶다면 필독」

${FORMAT_SPEC}`;

/**
 * 수집 글감 → 블로그 글 생성. 형식 위반 시 오류를 피드백해 1회 자동 재생성.
 * @returns {Promise<{raw: string, parsed: {meta, blocks}}>}
 */
export async function generatePost({ crawlContent, instruction = '', clinic = {}, log }) {
  // 병원명이 입력되면 "병원 명의 환자 대상 원고", 아니면 "몽PD 칼럼"
  const isClinic = !!String(clinic.name || '').trim();
  const mode = isClinic ? 'clinic' : 'column';
  log(`AI 글 생성을 시작합니다 (${isClinic ? '병원 명의 원고' : '몽PD 칼럼'} 모드, Claude 구독 계정 사용)...`);

  const persona = await loadPersona(log, mode);
  if (persona) log('스타일 가이드를 적용합니다.');
  const published = recentTitles();
  // 제목이 한 가지 패턴으로 굳지 않도록 실제 제목 예시를 매번 다르게 섞어 넣는다
  const titleExamples = isClinic ? [] : loadTitleExamples(18);

  const clinicBlock = isClinic
    ? `--- 이 글의 화자 (이 병원 원장님이 직접 쓰는 글입니다) ---

병원명: ${clinic.name}
원장님 성함: ${clinic.doctor || '(성함 미입력 — "대표원장"으로만 표기)'}
진료과목: ${clinic.dept || '(미입력)'}
${clinic.topic ? `다룰 시술·치료: ${clinic.topic}` : ''}

`
    : '';

  const basePrompt = `${persona ? `--- 글쓰기 스타일 가이드 (반드시 이 구조·문체로 작성) ---

${persona}

` : ''}${clinicBlock}${titleExamples.length ? `--- 제목 스타일 예시 (이런 후킹·톤으로 쓰되, 그대로 베끼지 말 것) ---

${titleExamples.map((t) => `- ${t}`).join('\n')}

` : ''}${published.length ? `--- 이미 발행한 글 제목 (주제·제목 패턴 중복 금지) ---

${published.map((t) => `- ${t}`).join('\n')}

` : ''}--- 수집된 글감 (뉴스·인기 블로그) ---

${crawlContent}

${instruction ? `--- 추가 요청사항 ---

${instruction}

` : ''}위 글감을 바탕으로 네이버 블로그 글 1편을 지정된 형식으로 작성해 주세요.`;

  const systemPrompt = isClinic ? CLINIC_SYSTEM : COLUMN_SYSTEM;
  let raw = await runClaude({ systemPrompt, prompt: basePrompt, log });

  // 파싱·검증 → 실패 시 1회 재생성
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = parsePost(raw);
      const errors = validatePost(parsed);
      if (errors.length) throw new Error(errors.join(' / '));
      log(`생성 완료: "${parsed.meta.title}" (블록 ${parsed.blocks.length}개, 이미지 ${parsed.meta.imageQueries.length}개)`);
      return { raw, parsed };
    } catch (e) {
      if (attempt === 1) {
        throw new Error(`AI 출력 형식 오류: ${e.message} — 초안을 수동으로 수정해 주세요.`);
      }
      log(`⚠ 형식 오류(${e.message}) — 자동 재생성 시도...`);
      raw = await runClaude({
        systemPrompt,
        prompt: `${basePrompt}

--- 직전 출력의 형식 오류 ---
${e.message}

위 오류를 수정하여 형식을 정확히 지켜 다시 작성해 주세요.`,
        log,
      });
    }
  }
}
