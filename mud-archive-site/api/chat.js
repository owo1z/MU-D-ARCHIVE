/* ============================================================
   MU:D ARCHIVE — 고객 상담 챗봇 (Vercel Function)

   질문이 들어오면 api/_knowledge.js 에서 관련 있는 구간만 골라
   AI에게 보내고, 그 구간에 적힌 내용만으로 답하게 합니다.

   ■ Gemini 로 쓰는 경우 (무료 한도가 있습니다)
     Vercel → Settings → Environment Variables
       GEMINI_API_KEY : AIza... 로 시작하는 구글 키
       GEMINI_MODEL   : gemini-3.8-flash   (비워두면 이 값이 쓰입니다)

   ■ Claude 로 쓰는 경우
       ANTHROPIC_API_KEY : sk-ant-api03... 로 시작하는 키
       CLAUDE_MODEL      : claude-opus-5-5

   ■ 둘 다 넣어둔 경우
       AI_PROVIDER 에 gemini 또는 claude 를 적어 고릅니다.
       안 적으면 Gemini 를 먼저 씁니다.

   잘 안 될 때는 주소창에 /api/chat?check=1 을 열어보세요.
   ============================================================ */

var KNOWLEDGE = require('./_knowledge.js');

var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
var GEMINI_DEFAULT = 'gemini-3.8-flash';

var CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_VERSION = '2023-06-01';
var CLAUDE_DEFAULT = 'claude-opus-5-5';

var MAX_Q = 500;          /* 질문 글자 수 상한 */
var MAX_TURNS = 8;        /* 참고할 이전 대화 수 */
var TOP_K = 6;            /* 질문마다 골라 넣을 구간 수 */
var MAX_CONTEXT = 7000;   /* 골라 넣을 글자 수 상한 */
var MAX_OUT = 700;        /* 답변 길이 상한 */

/* ---------- 어느 쪽을 쓸지 정합니다 ---------- */
function pickProvider() {
  var want = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  var gKey = (process.env.GEMINI_API_KEY || '').trim();
  var cKey = (process.env.ANTHROPIC_API_KEY || '').trim();

  if (want === 'gemini') return { name: 'gemini', key: gKey, model: (process.env.GEMINI_MODEL || GEMINI_DEFAULT).trim() };
  if (want === 'claude') return { name: 'claude', key: cKey, model: (process.env.CLAUDE_MODEL || CLAUDE_DEFAULT).trim() };
  if (gKey) return { name: 'gemini', key: gKey, model: (process.env.GEMINI_MODEL || GEMINI_DEFAULT).trim() };
  if (cKey) return { name: 'claude', key: cKey, model: (process.env.CLAUDE_MODEL || CLAUDE_DEFAULT).trim() };
  return { name: 'none', key: '', model: '' };
}

/* ---------- 지식베이스를 구간으로 나눕니다 ---------- */
var SECTIONS = (function () {
  var out = [];
  String(KNOWLEDGE).split(/\n(?=##\s)/).forEach(function (block) {
    var b = block.trim();
    if (!b) return;
    var nl = b.indexOf('\n');
    var title = (nl === -1 ? b : b.slice(0, nl)).replace(/^##\s*/, '').trim();
    var body = nl === -1 ? '' : b.slice(nl + 1).trim();
    if (!title) return;
    out.push({ title: title, body: body, text: title + '\n' + body });
  });
  return out;
})();

/* 운영자가 아직 채우지 않은 구간 */
function isEmpty(sec) { return sec.body.indexOf('[운영자 입력 필요]') !== -1; }

/* ---------- 검색 ----------
   한국어는 띄어쓰기만으로 잘 나뉘지 않으므로,
   낱말과 2글자 조각을 함께 비교합니다. */
function pieces(s) {
  var t = String(s || '').toLowerCase().replace(/[^0-9a-z가-힣\s]/g, ' ');
  var words = t.split(/\s+/).filter(function (w) { return w.length > 1; });
  var grams = [];
  words.forEach(function (w) {
    if (/[가-힣]/.test(w)) for (var i = 0; i < w.length - 1; i++) grams.push(w.slice(i, i + 2));
  });
  return { words: words, grams: grams };
}

function score(sec, q) {
  var hay = sec.text.toLowerCase(), s = 0;
  q.words.forEach(function (w) {
    if (sec.title.toLowerCase().indexOf(w) !== -1) s += 6;   /* 제목에 있으면 가중 */
    if (hay.indexOf(w) !== -1) s += 3;
  });
  q.grams.forEach(function (g) {
    if (sec.title.toLowerCase().indexOf(g) !== -1) s += 1.2;
    if (hay.indexOf(g) !== -1) s += 0.5;
  });
  return s;
}

function retrieve(question) {
  var q = pieces(question);
  var ranked = SECTIONS.map(function (sec) { return { sec: sec, s: score(sec, q) }; })
                       .sort(function (a, b) { return b.s - a.s; });
  var picked = [], used = 0;
  ranked.forEach(function (r) {
    if (picked.length >= TOP_K || r.s <= 0) return;
    if (used + r.sec.text.length > MAX_CONTEXT) return;
    picked.push(r.sec); used += r.sec.text.length;
  });
  /* 답변 원칙과 기본 정보는 언제나 함께 넣습니다 */
  ['답변 원칙', '브랜드 기본 정보'].forEach(function (must) {
    var m = SECTIONS.find(function (s) { return s.title === must; });
    if (m && picked.indexOf(m) === -1 && used + m.text.length <= MAX_CONTEXT + 1200) {
      picked.unshift(m); used += m.text.length;
    }
  });
  return picked;
}

/* ---------- 본문 읽기 (멈추지 않도록 시간 제한) ---------- */
function readBody(req) {
  var b = req.body;
  if (b && typeof b === 'object' && Object.keys(b).length) return Promise.resolve(b);
  if (typeof b === 'string' && b.length) {
    try { return Promise.resolve(JSON.parse(b)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise(function (resolve) {
    var raw = '', done = false;
    var finish = function (v) { if (!done) { done = true; resolve(v); } };
    var timer = setTimeout(function () { finish({}); }, 4000);
    try {
      req.on('data', function (c) { raw += c; if (raw.length > 120000) finish({}); });
      req.on('end', function () { clearTimeout(timer); try { finish(JSON.parse(raw || '{}')); } catch (e) { finish({}); } });
      req.on('error', function () { clearTimeout(timer); finish({}); });
    } catch (e) { clearTimeout(timer); finish({}); }
  });
}

/* ---------- 과속 방지 (인스턴스 단위, 최선 노력) ---------- */
var hits = new Map();
function tooFast(ip, ms) {
  var now = Date.now(), last = hits.get(ip) || 0;
  if (now - last < ms) return true;
  hits.set(ip, now);
  if (hits.size > 500) hits.clear();
  return false;
}

/* ---------- 시스템 지침 ---------- */
function systemPrompt(sections) {
  var missing = SECTIONS.filter(isEmpty).map(function (s) { return s.title; });
  return [
    '당신은 패션 브랜드 MU:D ARCHIVE의 고객 상담 담당자입니다.',
    '',
    '[역할]',
    '브랜드와 제품에 대한 고객의 질문에 한국어로 답합니다.',
    '질문에 먼저 답하고, 필요한 설명만 덧붙입니다. 2~4문장이면 충분합니다.',
    '브랜드 이야기는 도움이 될 때만 짧게 더합니다.',
    '차분하고 담백한 말투를 씁니다. 과장된 홍보 문구나 이모지는 쓰지 않습니다.',
    '',
    '[반드시 지킬 것]',
    '아래 <자료>에 적힌 내용만 근거로 답합니다. 자료에 없는 사실은 절대 지어내지 않습니다.',
    '가격, 재고, 배송 일정, 반품 조건, 사이즈 수치, 소재 혼용률은 자료에 있을 때만 말합니다.',
    '자료에 "[운영자 입력 필요]"라고 적힌 항목은 아직 공개 전입니다.',
    '그 주제를 물으면 수치를 말하지 말고, 아직 안내가 어렵다고 말한 뒤 공식 창구로 안내합니다.',
    '기획 또는 개발 중인 제품을 이미 판매 중인 것처럼 말하지 않습니다.',
    '심리 상담이나 의학적 조언은 하지 않습니다. 감정을 성격 유형이나 진단으로 다루지 않습니다.',
    '브랜드 이름은 항상 MU:D ARCHIVE로 씁니다. 이전 이름 MoodisM은 이름이 바뀐 경위를 설명할 때만 언급합니다.',
    '자료로 답할 수 없으면 솔직히 모른다고 말하고, 사이트의 Q&A 게시판이나 mudarchive@gmail.com 으로 안내합니다.',
    '',
    missing.length ? '[아직 자료가 없는 주제] ' + missing.join(', ') : '',
    '',
    '<자료>',
    sections.map(function (s) { return '### ' + s.title + '\n' + s.body; }).join('\n\n'),
    '</자료>'
  ].filter(Boolean).join('\n');
}

/* ---------- 지난 대화를 하나의 글로 묶습니다 (Gemini용) ---------- */
function asText(history, question) {
  var lines = [];
  history.forEach(function (m) {
    lines.push((m.role === 'assistant' ? '상담원: ' : '고객: ') + m.content);
  });
  lines.push('고객: ' + question);
  lines.push('상담원:');
  return lines.join('\n');
}

/* ---------- 오류 메시지 읽기 ---------- */
async function errText(r) {
  var raw = '';
  try { raw = await r.text(); } catch (e) { return ''; }
  try {
    var j = JSON.parse(raw);
    return (j.error && (j.error.message || j.error.status)) || raw.slice(0, 200);
  } catch (e) { return raw.slice(0, 200); }
}

/* ---------- Gemini 호출 ---------- */
async function callGemini(p, system, history, question) {
  var r = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({
      model: p.model,
      system_instruction: system,
      input: asText(history, question),
      generation_config: { max_output_tokens: MAX_OUT }
    })
  });
  if (!r.ok) return { status: r.status, detail: await errText(r) };

  var d = await r.json();
  /* 답은 steps 안의 model_output 단계에 들어 있습니다.
     형식이 조금 달라져도 글자를 찾아내도록 넉넉하게 훑습니다. */
  var text = '';
  if (typeof d.output_text === 'string') text = d.output_text;
  if (!text && Array.isArray(d.steps)) {
    d.steps.forEach(function (st) {
      if (st && st.type === 'model_output' && Array.isArray(st.content)) {
        st.content.forEach(function (c) { if (c && c.type === 'text' && c.text) text += c.text; });
      }
    });
  }
  if (!text && d.candidates && d.candidates[0] && d.candidates[0].content) {
    (d.candidates[0].content.parts || []).forEach(function (c) { if (c && c.text) text += c.text; });
  }
  return { text: String(text).trim() };
}

/* ---------- Claude 호출 ---------- */
async function callClaude(p, system, history, question) {
  var msgs = [];
  history.forEach(function (m) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  });
  if (msgs.length && msgs[0].role !== 'user') msgs.shift();
  msgs.push({ role: 'user', content: question });

  var r = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': p.key, 'anthropic-version': CLAUDE_VERSION },
    body: JSON.stringify({ model: p.model, max_tokens: MAX_OUT, temperature: 0.3, system: system, messages: msgs })
  });
  if (!r.ok) return { status: r.status, detail: await errText(r) };

  var d = await r.json();
  var text = (d.content || []).filter(function (b) { return b.type === 'text'; })
                              .map(function (b) { return b.text; }).join('').trim();
  return { text: text };
}

/* ---------- 오류를 한국어로 ---------- */
function explain(p, status, detail) {
  var low = (detail || '').toLowerCase();
  if (low.indexOf('credit') !== -1 || low.indexOf('billing') !== -1 || low.indexOf('quota') !== -1 || status === 402) {
    return p.name === 'gemini'
      ? '제미나이 사용 한도를 넘었습니다. aistudio.google.com 에서 한도와 결제를 확인해 주세요.'
      : 'API 크레딧이 부족합니다. console.anthropic.com 의 Plans & Billing 에서 충전해 주세요.';
  }
  if (status === 401 || status === 403 || low.indexOf('api key not valid') !== -1 || low.indexOf('invalid x-api-key') !== -1) {
    return (p.name === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY') + ' 가 올바르지 않습니다. (' + detail + ')';
  }
  if (status === 404) {
    return (p.name === 'gemini' ? 'GEMINI_MODEL' : 'CLAUDE_MODEL') + ' 값(' + p.model + ')을 찾을 수 없습니다.';
  }
  if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  return '응답 ' + status + ' ' + detail;
}

/* ---------- 키 형태 (키 자체는 절대 보여주지 않습니다) ---------- */
function keyShape(p, raw) {
  if (!raw) return '키가 없습니다';
  var k = raw.trim();
  var masked = /·|…|\.\.\./.test(k);
  var form;
  if (p.name === 'gemini') {
    form = k.indexOf('AIza') === 0
      ? (k.length >= 35 ? '구글 표준 키로 보입니다' : '길이가 너무 짧습니다 — 잘린 키입니다')
      : 'AIza 로 시작하지 않습니다 — 구글 API 키가 아닙니다';
  } else {
    form = k.indexOf('sk-ant-api') === 0
      ? (k.length >= 90 ? 'Anthropic 표준 키로 보입니다' : '길이가 너무 짧습니다 — 잘린 키입니다')
      : (k.indexOf('sk-ant-admin') === 0 ? 'Admin 키입니다 — 상담에는 쓸 수 없습니다'
                                         : 'sk-ant-api 로 시작하지 않습니다 — Anthropic 키가 아닙니다');
  }
  return {
    앞부분: k.slice(0, 13) + '…',
    길이: k.length,
    앞뒤공백: raw === k ? '없음' : '있었음(자동으로 제거함)',
    가려진문자: masked ? '있음 — 목록의 미리보기를 복사하신 것 같습니다' : '없음',
    형식: form
  };
}

/* ---------- 핸들러 ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  function send(code, obj) { res.statusCode = code; res.end(JSON.stringify(obj)); }

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  var p = pickProvider();
  var rawKey = p.name === 'gemini' ? (process.env.GEMINI_API_KEY || '')
             : p.name === 'claude' ? (process.env.ANTHROPIC_API_KEY || '') : '';

  /* 점검: /api/chat?check=1 */
  if (req.method === 'GET' && /[?&]check=/.test(req.url || '')) {
    var report = {
      사용중인AI: p.name === 'none' ? '없음 — 키를 넣어주세요'
                 : (p.name === 'gemini' ? 'Gemini' : 'Claude') + ' / ' + p.model,
      환경변수: {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY ? '설정됨' : '없음',
        GEMINI_MODEL: process.env.GEMINI_MODEL || '(미설정 — ' + GEMINI_DEFAULT + ' 사용)',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '설정됨' : '없음',
        CLAUDE_MODEL: process.env.CLAUDE_MODEL || '(미설정 — ' + CLAUDE_DEFAULT + ' 사용)',
        AI_PROVIDER: process.env.AI_PROVIDER || '(미설정 — 키가 있는 쪽을 자동 선택)'
      },
      키형태: keyShape(p, rawKey),
      지식베이스: {
        구간수: SECTIONS.length,
        글자수: String(KNOWLEDGE).length,
        아직_비어있는_구간: SECTIONS.filter(isEmpty).map(function (s) { return s.title; })
      }
    };
    if (p.name === 'none' || !p.key) {
      report.결과 = 'GEMINI_API_KEY 또는 ANTHROPIC_API_KEY 를 넣고 Redeploy 해주세요.';
      send(200, report); return;
    }
    try {
      var sys = '한국어로 한 단어만 답하세요.';
      var out = p.name === 'gemini' ? await callGemini(p, sys, [], '안녕')
                                    : await callClaude(p, sys, [], '안녕');
      report.결과 = out.status ? explain(p, out.status, out.detail)
                              : '정상입니다. ' + p.model + ' 응답을 받았습니다.';
    } catch (e) { report.결과 = String(e && e.message || e); }
    send(200, report); return;
  }

  if (req.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }

  if (p.name === 'none' || !p.key) {
    send(503, { error: '상담 챗봇이 아직 준비되지 않았습니다. 사이트의 Q&A 게시판에 남겨주시면 직접 답변드립니다.', setup: true });
    return;
  }

  try {
    var body = await readBody(req);
    var question = String(body.question || '').trim().slice(0, MAX_Q);
    if (question.length < 2) { send(400, { error: '질문을 입력해 주세요.' }); return; }

    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (tooFast(ip, 2500)) { send(429, { error: '잠시만 기다렸다가 다시 보내주세요.' }); return; }

    var history = [];
    (Array.isArray(body.history) ? body.history.slice(-MAX_TURNS) : []).forEach(function (m) {
      if (!m || typeof m.content !== 'string') return;
      var c = m.content.trim().slice(0, 1200);
      if (c) history.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
    });

    var picked = retrieve(question);
    var sys2 = systemPrompt(picked);
    var out2 = p.name === 'gemini' ? await callGemini(p, sys2, history, question)
                                   : await callClaude(p, sys2, history, question);

    if (out2.status) {
      /* 손님에게는 내부 사정을 드러내지 않습니다.
         자세한 원인은 /api/chat?check=1 에서 운영자만 봅니다. */
      if (out2.status === 429) { send(429, { error: '지금 요청이 많습니다. 잠시 후 다시 시도해 주세요.' }); return; }
      send(503, { error: '지금은 상담 연결이 어렵습니다. 아래 Q&A 게시판에 남겨주시면 운영자가 직접 답변드립니다.' });
      return;
    }
    if (!out2.text) { send(502, { error: '답변이 비어 있습니다. 다시 시도해 주세요.' }); return; }

    send(200, { ok: true, answer: out2.text, sources: picked.map(function (s) { return s.title; }) });

  } catch (e) {
    send(500, { error: '처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' });
  }
};
