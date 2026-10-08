/* ============================================================
   MU:D ARCHIVE — Q&A API  (Vercel Function)
   질문과 댓글을 GitHub 저장소의 data/qna.json 에 기록합니다.
   외부 서비스 없이 GitHub + Vercel 만 사용합니다.

   Vercel → Settings → Environment Variables 에 세 가지를 넣어주세요.
     GITHUB_TOKEN    : GitHub 토큰 (Contents 읽기/쓰기, 이 저장소에만)
     GITHUB_REPO     : 사용자이름/저장소이름   예) hyeon/mud-archive
     ADMIN_PASSWORD  : 운영자 답변·삭제에 쓸 비밀번호 (직접 정하세요)
   ============================================================ */

var DATA_PATH = 'data/qna.json';
var BRANCH = 'main';
var MAX_QUESTIONS = 500;

/* 따뜻한 인스턴스에서 잠깐 재사용 — GitHub 호출 횟수를 줄입니다 */
var cache = { at: 0, etag: null, data: null, sha: null };
var CACHE_MS = 3000;

/* 아주 단순한 과속 방지 (인스턴스 단위, 최선 노력) */
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

async function readFile(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) {
    return { data: cache.data, sha: cache.sha };
  }
  var r = await fetch(api('/contents/' + DATA_PATH + '?ref=' + BRANCH), {
    headers: ghHeaders(),
    cache: 'no-store'
  });
  if (r.status === 404) return { data: { questions: [] }, sha: null };
  if (!r.ok) throw new Error('GitHub read ' + r.status + ' ' + (await r.text()).slice(0, 180));

  var j = await r.json();
  var text = Buffer.from(j.content || '', 'base64').toString('utf8');
  var data;
  try { data = JSON.parse(text); } catch (e) { data = { questions: [] }; }
  if (!data || !Array.isArray(data.questions)) data = { questions: [] };

  cache = { at: Date.now(), data: data, sha: j.sha };
  return { data: data, sha: j.sha };
}

async function writeFile(data, sha, message) {
  var body = {
    message: message,
    content: Buffer.from(JSON.stringify(data, null, 1), 'utf8').toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  var r = await fetch(api('/contents/' + DATA_PATH), {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
    body: JSON.stringify(body)
  });
  if (r.status === 409 || r.status === 422) return false;      // 다른 사람이 먼저 썼습니다
  if (!r.ok) throw new Error('GitHub write ' + r.status + ' ' + (await r.text()).slice(0, 180));

  var j = await r.json();
  cache = { at: Date.now(), data: data, sha: j.content && j.content.sha };
  return true;
}

/* 충돌이 나면 최신 내용을 다시 읽어 적용합니다 */
async function change(fn, message) {
  for (var i = 0; i < 4; i++) {
    var cur = await readFile(i > 0);
    var next = JSON.parse(JSON.stringify(cur.data));
    var result = fn(next);
    if (result && result.error) return result;
    if (await writeFile(next, cur.sha, message)) return { ok: true, value: result };
    await new Promise(function (r) { setTimeout(r, 120 + Math.random() * 220); });
  }
  return { error: '지금 다른 분이 글을 남기는 중입니다. 잠시 후 다시 시도해 주세요.', status: 503 };
}

function id() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    res.status(500).json({ error: 'GITHUB_TOKEN 과 GITHUB_REPO 환경 변수를 Vercel에 설정해 주세요.' });
    return;
  }

  try {
    /* ---------- 읽기 ---------- */
    if (req.method === 'GET') {
      var cur = await readFile(false);
      res.status(200).json({ ok: true, questions: cur.data.questions });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    /* ---------- 쓰기 ---------- */
    var body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body) {
      var raw = '';
      for await (var chunk of req) raw += chunk;
      try { body = JSON.parse(raw); } catch (e) { body = {}; }
    }

    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    var action = body.action;

    if (action === 'login') {
      res.status(isAdmin(body.password) ? 200 : 401)
         .json(isAdmin(body.password) ? { ok: true } : { error: '비밀번호가 맞지 않습니다.' });
      return;
    }

    var admin = isAdmin(body.password);

    if (action === 'ask' || action === 'reply') {
      if (!admin && tooFast(ip, 4000)) {
        res.status(429).json({ error: '너무 빠릅니다. 몇 초 뒤에 다시 시도해 주세요.' });
        return;
      }
      var name = clean(body.name, 24);
      var text = clean(body.body, 1000);
      if (name.length < 1 || text.length < 2) {
        res.status(400).json({ error: '이름과 내용을 채워주세요.' });
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
      if (out.error) { res.status(out.status || 500).json({ error: out.error }); return; }
      var after = await readFile(false);
      res.status(200).json({ ok: true, questions: after.data.questions });
      return;
    }

    if (action === 'delete') {
      if (!admin) { res.status(401).json({ error: '운영자만 지울 수 있습니다.' }); return; }
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
      if (del.error) { res.status(del.status || 500).json({ error: del.error }); return; }
      var now = await readFile(false);
      res.status(200).json({ ok: true, questions: now.data.questions });
      return;
    }

    res.status(400).json({ error: '알 수 없는 요청입니다.' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
