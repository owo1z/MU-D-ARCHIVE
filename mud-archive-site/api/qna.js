/* ============================================================
   MU:D ARCHIVE — Q&A API  (Vercel Function)
   질문과 댓글을 GitHub 저장소의 data/qna.json 에 기록합니다.
   외부 서비스 없이 GitHub + Vercel 만 사용합니다.

   Vercel → Settings → Environment Variables 에 세 가지를 넣어주세요.
     GITHUB_TOKEN    : GitHub 토큰 (Contents 읽기/쓰기, 이 저장소에만)
     GITHUB_REPO     : 사용자이름/저장소이름   예) hyeon/mud-archive
     ADMIN_PASSWORD  : 운영자 답변·삭제에 쓸 비밀번호 (직접 정하세요)

   잘 안 될 때는 주소창에 /api/qna?check=1 을 열어보세요.
   무엇이 빠졌는지 알려줍니다.
   ============================================================ */

var DATA_PATH = 'data/qna.json';
var MAX_QUESTIONS = 500;

var cache = { at: 0, data: null, sha: null };
var CACHE_MS = 3000;
var branchCache = null;

var hits = new Map();
function tooFast(ip, ms) {
  var now = Date.now(), last = hits.get(ip) || 0;
  if (now - last < ms) return true;
  hits.set(ip, now);
  if (hits.size > 500) hits.clear();
  return false;
}

function api(path) {
  return 'https://api.github.com/repos/' + process.env.GITHUB_REPO + path;
}
function ghHeaders() {
  return {
    Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mud-archive-qna'
  };
}

/* GitHub가 돌려준 오류를 사람이 읽을 수 있게 */
async function ghError(r, what) {
  var detail = '';
  try {
    var j = await r.json();
    detail = j && (j.message || '') ;
  } catch (e) { detail = (await r.text().catch(function () { return ''; })).slice(0, 160); }

  if (r.status === 401) return 'GITHUB_TOKEN 이 올바르지 않습니다. 토큰을 새로 만들어 다시 넣어주세요.';
  if (r.status === 403) return 'GITHUB_TOKEN 에 이 저장소의 Contents 쓰기 권한이 없습니다. (' + detail + ')';
  if (r.status === 404) return 'GITHUB_REPO 값(' + process.env.GITHUB_REPO + ')을 찾을 수 없습니다. 사용자이름/저장소이름 형식이 맞는지 확인해 주세요.';
  return what + ' 실패 (' + r.status + ') ' + detail;
}

/* 기본 브랜치를 직접 확인합니다 — main 이 아닌 저장소도 있습니다 */
async function branch() {
  if (branchCache) return branchCache;
  var r = await fetch(api(''), { headers: ghHeaders(), cache: 'no-store' });
  if (!r.ok) throw new Error(await ghError(r, '저장소 확인'));
  var j = await r.json();
  branchCache = j.default_branch || 'main';
  return branchCache;
}

async function readFile(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) {
    return { data: cache.data, sha: cache.sha };
  }
  var br = await branch();
  var r = await fetch(api('/contents/' + DATA_PATH + '?ref=' + encodeURIComponent(br)), {
    headers: ghHeaders(), cache: 'no-store'
  });
  if (r.status === 404) return { data: { questions: [] }, sha: null };   // 아직 파일이 없으면 새로 만듭니다
  if (!r.ok) throw new Error(await ghError(r, '읽기'));

  var j = await r.json();
  var text = Buffer.from(j.content || '', 'base64').toString('utf8');
  var data;
  try { data = JSON.parse(text); } catch (e) { data = { questions: [] }; }
  if (!data || !Array.isArray(data.questions)) data = { questions: [] };

  cache = { at: Date.now(), data: data, sha: j.sha };
  return { data: data, sha: j.sha };
}

async function writeFile(data, sha, message) {
  var br = await branch();
  var body = {
    message: message,
    content: Buffer.from(JSON.stringify(data, null, 1), 'utf8').toString('base64'),
    branch: br
  };
  if (sha) body.sha = sha;

  var r = await fetch(api('/contents/' + DATA_PATH), {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
    body: JSON.stringify(body)
  });
  if (r.status === 409 || r.status === 422) return false;    // 다른 사람이 먼저 썼습니다
  if (!r.ok) throw new Error(await ghError(r, '쓰기'));

  var j = await r.json();
  cache = { at: Date.now(), data: data, sha: j.content && j.content.sha };
  return true;
}

async function change(fn, message) {
  for (var i = 0; i < 4; i++) {
    var cur = await readFile(i > 0);
    var next = JSON.parse(JSON.stringify(cur.data));
    var result = fn(next);
    if (result && result.error) return result;
    if (await writeFile(next, cur.sha, message)) return { ok: true };
    await new Promise(function (r) { setTimeout(r, 120 + Math.random() * 220); });
  }
  return { error: '지금 다른 분이 글을 남기는 중입니다. 잠시 후 다시 시도해 주세요.', status: 503 };
}

function id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\u0000/g, '').trim().slice(0, max);
}
function isAdmin(pw) {
  var real = process.env.ADMIN_PASSWORD || '';
  if (!real || typeof pw !== 'string' || pw.length !== real.length) return false;
  var diff = 0;
  for (var i = 0; i < real.length; i++) diff |= real.charCodeAt(i) ^ pw.charCodeAt(i);
  return diff === 0;
}

/* 본문 읽기 — 어떤 경우에도 멈추지 않도록 시간 제한을 둡니다 */
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
      req.on('data', function (c) { raw += c; if (raw.length > 200000) finish({}); });
      req.on('end', function () {
        clearTimeout(timer);
        try { finish(JSON.parse(raw || '{}')); } catch (e) { finish({}); }
      });
      req.on('error', function () { clearTimeout(timer); finish({}); });
    } catch (e) { clearTimeout(timer); finish({}); }
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  function send(code, obj) { res.statusCode = code; res.end(JSON.stringify(obj)); }

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  var hasToken = !!process.env.GITHUB_TOKEN;
  var hasRepo = !!process.env.GITHUB_REPO;
  var hasPw = !!process.env.ADMIN_PASSWORD;

  /* ---------- 점검: /api/qna?check=1 ---------- */
  if (req.method === 'GET' && /[?&]check=/.test(req.url || '')) {
    var report = {
      환경변수: {
        GITHUB_TOKEN: hasToken ? '설정됨' : '없음',
        GITHUB_REPO: hasRepo ? process.env.GITHUB_REPO : '없음',
        ADMIN_PASSWORD: hasPw ? '설정됨' : '없음'
      }
    };
    if (!hasToken || !hasRepo) {
      report.결과 = '환경 변수를 넣고 Vercel에서 Redeploy 해주세요.';
      send(200, report); return;
    }
    try {
      report.기본브랜치 = await branch();
      var cur = await readFile(true);
      report.데이터파일 = { 경로: DATA_PATH, 있음: cur.sha ? '예' : '아니오(첫 글을 쓸 때 만들어집니다)', 질문수: cur.data.questions.length };
      report.쓰기권한 = '확인하려면 질문을 하나 올려보세요.';
      report.결과 = '정상입니다.';
    } catch (e) {
      report.결과 = String(e && e.message || e);
    }
    send(200, report); return;
  }

  if (!hasToken || !hasRepo) {
    send(500, { error: 'Vercel 환경 변수 GITHUB_TOKEN 과 GITHUB_REPO 를 넣고 Redeploy 해주세요.', setup: true });
    return;
  }

  try {
    if (req.method === 'GET') {
      var cur2 = await readFile(false);
      send(200, { ok: true, questions: cur2.data.questions });
      return;
    }

    if (req.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }

    var body = await readBody(req);
    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    var action = body.action;

    if (action === 'login') {
      if (!hasPw) { send(500, { error: 'ADMIN_PASSWORD 가 설정되어 있지 않습니다.' }); return; }
      if (isAdmin(body.password)) send(200, { ok: true });
      else send(401, { error: '비밀번호가 맞지 않습니다.' });
      return;
    }

    var admin = isAdmin(body.password);

    if (action === 'ask' || action === 'reply') {
      if (!admin && tooFast(ip, 4000)) {
        send(429, { error: '너무 빠릅니다. 몇 초 뒤에 다시 시도해 주세요.' });
        return;
      }
      var name = clean(body.name, 24);
      var text = clean(body.body, 1000);
      if (name.length < 1 || text.length < 2) {
        send(400, { error: '이름과 내용을 채워주세요.' });
        return;
      }

      var out;
      if (action === 'ask') {
        out = await change(function (d) {
          d.questions.unshift({
            id: id(), created_at: new Date().toISOString(),
            name: name, body: text, replies: []
          });
          if (d.questions.length > MAX_QUESTIONS) d.questions.length = MAX_QUESTIONS;
        }, 'qna: 질문 (' + name + ')');
      } else {
        out = await change(function (d) {
          var q = d.questions.find(function (x) { return x.id === body.question_id; });
          if (!q) return { error: '질문을 찾을 수 없습니다.', status: 404 };
          if (!Array.isArray(q.replies)) q.replies = [];
          q.replies.push({
            id: id(), created_at: new Date().toISOString(),
            name: name, body: text, is_staff: admin
          });
        }, 'qna: 댓글 (' + name + ')');
      }
      if (out.error) { send(out.status || 500, { error: out.error }); return; }
      send(200, { ok: true, questions: cache.data.questions });
      return;
    }

    if (action === 'delete') {
      if (!admin) { send(401, { error: '운영자만 지울 수 있습니다.' }); return; }
      var del = await change(function (d) {
        if (body.kind === 'question') {
          d.questions = d.questions.filter(function (q) { return q.id !== body.id; });
        } else {
          d.questions.forEach(function (q) {
            if (Array.isArray(q.replies)) {
              q.replies = q.replies.filter(function (r) { return r.id !== body.id; });
            }
          });
        }
      }, 'qna: 삭제');
      if (del.error) { send(del.status || 500, { error: del.error }); return; }
      send(200, { ok: true, questions: cache.data.questions });
      return;
    }

    send(400, { error: '알 수 없는 요청입니다. (action=' + String(action) + ')' });
  } catch (e) {
    send(500, { error: String(e && e.message || e) });
  }
};
