/* ============================================================
   MU:D ARCHIVE — 고객 상담 챗봇 (Vercel Function)

   질문이 들어오면 api/_knowledge.js 에서 관련 있는 구간만 골라
   Claude 에게 보내고, 그 구간에 적힌 내용만으로 답하게 합니다.

   Vercel → Settings → Environment Variables 에 두 가지를 넣어주세요.
     ANTHROPIC_API_KEY : Anthropic 콘솔에서 발급한 키 (sk-ant-...)
     CLAUDE_MODEL      : claude-opus-5-5

   잘 안 될 때는 주소창에 /api/chat?check=1 을 열어보세요.
   ============================================================ */

var KNOWLEDGE = require('./_knowledge.js');

var API_URL = 'https://api.anthropic.com/v1/messages';
var API_VERSION = '2023-06-01';
var DEFAULT_MODEL = 'claude-opus-5-5';

var MAX_Q = 500;          /* 질문 글자 수 상한 */
var MAX_TURNS = 8;        /* 참고할 이전 대화 수 */
var TOP_K = 6;            /* 질문마다 골라 넣을 구간 수 */
var MAX_CONTEXT = 7000;   /* 골라 넣을 글자 수 상한 */

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
    if (/[가-힣]/.test(w)) {
      for (var i = 0; i < w.length - 1; i++) grams.push(w.slice(i, i + 2));
    }
  });
  return { words: words, grams: grams };
}

function score(sec, q) {
  var hay = sec.text.toLowerCase();
  var s = 0;
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
  var ranked = SECTIONS.map(function (sec) {
    return { sec: sec, s: score(sec, q) };
  }).sort(function (a, b) { return b.s - a.s; });

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

/* ---------- 핸들러 ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  function send(code, obj) { res.statusCode = code; res.end(JSON.stringify(obj)); }

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  var hasKey = !!process.env.ANTHROPIC_API_KEY;
  var model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

  /* 점검: /api/chat?check=1 */
  if (req.method === 'GET' && /[?&]check=/.test(req.url || '')) {
    var report = {
      환경변수: {
        ANTHROPIC_API_KEY: hasKey ? '설정됨' : '없음',
        CLAUDE_MODEL: process.env.CLAUDE_MODEL || '(미설정 — ' + DEFAULT_MODEL + ' 사용)'
      },
      지식베이스: {
        구간수: SECTIONS.length,
        글자수: String(KNOWLEDGE).length,
        제목: SECTIONS.map(function (s) { return s.title; }),
        아직_비어있는_구간: SECTIONS.filter(isEmpty).map(function (s) { return s.title; })
      }
    };
    if (!hasKey) {
      report.결과 = 'ANTHROPIC_API_KEY 를 Vercel 환경 변수에 넣고 Redeploy 해주세요.';
      send(200, report); return;
    }
    try {
      var ping = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': API_VERSION
        },
        body: JSON.stringify({ model: model, max_tokens: 16, messages: [{ role: 'user', content: '안녕' }] })
      });
      if (ping.ok) report.결과 = '정상입니다. 모델 ' + model + ' 응답을 받았습니다.';
      else {
        var et = await ping.text();
        var msg = '';
        try { msg = (JSON.parse(et).error || {}).message || ''; } catch (e) { msg = et.slice(0, 200); }
        if (ping.status === 401) report.결과 = 'ANTHROPIC_API_KEY 가 올바르지 않습니다. (' + msg + ')';
        else if (ping.status === 404) report.결과 = 'CLAUDE_MODEL 값(' + model + ')을 찾을 수 없습니다. claude-opus-5-5 인지 확인해 주세요.';
        else if (ping.status === 400) report.결과 = '요청이 거절되었습니다. 모델 이름을 확인해 주세요. (' + msg + ')';
        else report.결과 = 'Anthropic 응답 ' + ping.status + ' ' + msg;
      }
    } catch (e) {
      report.결과 = String(e && e.message || e);
    }
    send(200, report); return;
  }

  if (req.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }

  if (!hasKey) {
    send(503, { error: '상담 챗봇이 아직 준비되지 않았습니다. 사이트의 Q&A 게시판에 남겨주시면 직접 답변드립니다.', setup: true });
    return;
  }

  try {
    var body = await readBody(req);
    var question = String(body.question || '').trim().slice(0, MAX_Q);
    if (question.length < 2) { send(400, { error: '질문을 입력해 주세요.' }); return; }

    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (tooFast(ip, 2500)) { send(429, { error: '잠시만 기다렸다가 다시 보내주세요.' }); return; }

    /* 이전 대화 (사용자가 보낸 것만 신뢰하고 역할·길이를 정리합니다) */
    var history = Array.isArray(body.history) ? body.history.slice(-MAX_TURNS) : [];
    var msgs = [];
    history.forEach(function (m) {
      if (!m || typeof m.content !== 'string') return;
      var role = m.role === 'assistant' ? 'assistant' : 'user';
      var c = m.content.trim().slice(0, 1200);
      if (c) msgs.push({ role: role, content: c });
    });
    if (msgs.length && msgs[0].role !== 'user') msgs.shift();
    msgs.push({ role: 'user', content: question });

    var picked = retrieve(question);

    var r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': API_VERSION
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 700,
        temperature: 0.3,
        system: systemPrompt(picked),
        messages: msgs
      })
    });

    if (!r.ok) {
      var txt = await r.text();
      var detail = '';
      try { detail = (JSON.parse(txt).error || {}).message || ''; } catch (e) { detail = txt.slice(0, 160); }
      if (r.status === 401) { send(500, { error: 'API 키가 올바르지 않습니다. 운영자에게 알려주세요.' }); return; }
      if (r.status === 404 || r.status === 400) { send(500, { error: '모델 설정을 확인해 주세요. (' + detail + ')' }); return; }
      if (r.status === 429) { send(429, { error: '지금 요청이 많습니다. 잠시 후 다시 시도해 주세요.' }); return; }
      send(502, { error: '답변을 받지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }

    var data = await r.json();
    var answer = (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('')
      .trim();

    if (!answer) { send(502, { error: '답변이 비어 있습니다. 다시 시도해 주세요.' }); return; }

    send(200, {
      ok: true,
      answer: answer,
      sources: picked.map(function (s) { return s.title; })
    });

  } catch (e) {
    send(500, { error: '처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.' });
  }
};
