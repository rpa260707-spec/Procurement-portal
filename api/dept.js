import { get } from '@vercel/blob';
import { verify, sb, normDept } from './_supabase.js';

/* Vercel Blob 자격 찾기 — state.js 와 같은 방식입니다.
   Storage 연결 시 접두사가 붙으면 기본 이름이 없어 403 이 납니다. */
const BLOB_OPT = (() => {
  const pick = (suffix) => {
    if (process.env['BLOB' + suffix]) return process.env['BLOB' + suffix];
    const key = Object.keys(process.env).find((n) => n.endsWith(suffix) && process.env[n]);
    return key ? process.env[key] : undefined;
  };
  const token = pick('_READ_WRITE_TOKEN');
  const storeId = pick('_STORE_ID');
  const o = {};
  if (token) o.token = token;
  else if (storeId) o.storeId = storeId;
  return o;
})();

// 수요부서용 조회 API
//
// 수요부서 구매현황 화면(dept.html)이 씁니다. GRFITI 계정으로 로그인한 사람의 **그 부서 건만** 돌려줍니다.
// 부서는 화면이 보낸 값이 아니라 로그인 토큰 → 계정의 dept_name 으로 정합니다.
// 화면에서 거르지 않고 여기서 자르는 이유:
//   화면에서만 거르면 전 부서 데이터가 브라우저까지 다 내려갑니다.
//   소스를 열어 보면 다른 팀 단가가 그대로 보입니다. 그래서 서버에서 자릅니다.
//
// 개인정보는 없습니다. 이 데이터에는 이름·연락처가 들어 있지 않고
// 발주일 · 부서 · 품목 · 품목코드 · 분류 · 계약구분 · 수량 · 금액 · 단가 뿐입니다.

const FILE_NAME = 'procurement-state.json';

function setHeaders(res) {
  // 같은 출처(구매현황 프로젝트) 에서만 부릅니다. 교차 출처는 열지 않습니다.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

async function streamToText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

/* 발주 데이터(Blob)와 검수 대기(GRFITI)는 **출처가 다릅니다.**
   전에는 Blob 이 터지면 Promise.all 이 통째로 넘어가 검수 대기까지 「불러오는 중…」에서 멈췄습니다.
   한쪽이 없어도 다른 쪽은 보여야 합니다. 그래서 여기서 삼키고 사유만 올려 보냅니다.

   터지는 것만 막아서는 모자랐습니다 — 자격이 없으면 get() 이 **응답 없이 매달리는** 때가 있어
   Promise.all 이 끝나지 않고 검수 대기가 다시 「불러오는 중…」에 갇혔습니다.
   그래서 (1) 자격이 아예 없으면 부르지 않고 (2) 불러도 6초를 넘기면 끊습니다. */
const BLOB_TIMEOUT_MS = 6000;
const NEED_STORE = 'Vercel Blob 저장소가 이 프로젝트에 연결되지 않았습니다. Storage → Connect Store → Redeploy 가 필요합니다.';

async function readRows() {
  if (!BLOB_OPT.token && !BLOB_OPT.storeId) {
    return { rows: [], savedAt: '', error: NEED_STORE };     // 부를 자격이 없습니다 — 기다릴 이유도 없습니다
  }
  let timer;
  try {
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(Object.assign(new Error('blob timeout'), { timeout: true })), BLOB_TIMEOUT_MS);
    });
    return await Promise.race([readRowsRaw(), timeout]);
  } catch (e) {
    if (e && e.timeout) {
      return { rows: [], savedAt: '', error: '구매 데이터 저장소가 응답하지 않습니다 (6초 초과). ' + NEED_STORE };
    }
    const st = e?.status || e?.statusCode || e?.cause?.status;
    const m = String(e?.message || '');
    const notFound = st === 404 || /404|not found/i.test(m);
    return { rows: [], savedAt: '', error: notFound
      ? '구매 데이터 파일이 아직 없습니다 (procurement-state.json). 01 구매현황에서 한 번 저장하면 생깁니다.'
      : NEED_STORE };
  } finally {
    clearTimeout(timer);
  }
}

async function readRowsRaw() {
  const blob = await get(FILE_NAME, { access: 'private', ...BLOB_OPT });
  if (!blob || !blob.stream) return { rows: [], savedAt: '' };

  const text = await streamToText(blob.stream);
  if (!text) return { rows: [], savedAt: '' };

  const raw = JSON.parse(text);
  const keys = raw?.keys || {};

  // dashboard_db 는 JSON 문자열로 들어 있습니다.
  let list = [];
  try {
    const parsed = typeof keys.dashboard_db === 'string'
      ? JSON.parse(keys.dashboard_db)
      : keys.dashboard_db;
    if (Array.isArray(parsed)) list = parsed;
  } catch (e) { list = []; }

  // 배열 형태([날짜, 부서, 품목, 코드, 분류, 구분, 수량, 금액, 단가])를 객체로 폅니다.
  const rows = list.map((r) => Array.isArray(r)
    ? { date: r[0], dept: r[1], item: r[2], itemCode: r[3],
        category: r[4], procurementType: r[5], qty: r[6], amt: r[7], unitPrice: r[8] }
    : r);

  let savedAt = '';
  try {
    const info = typeof keys.dashboard_upload_info === 'string'
      ? JSON.parse(keys.dashboard_upload_info)
      : keys.dashboard_upload_info;
    savedAt = String(info?.savedAt || raw?.savedAt || '');
  } catch (e) { savedAt = String(raw?.savedAt || ''); }

  return { rows, savedAt };
}

const yearOf = (d) => String(d || '').slice(0, 4);

/* GRFITI 검수 대기(발주완료·미입고) — 로그인한 사람 토큰으로 읽어 Supabase 권한(RLS)이 그대로 적용됩니다.
   검수사진앱 구매목록과 같은 조건입니다. 표에 필요한 칸만 골라 내보냅니다. */
const PENDING_FIELDS = ['doc_no', 'applicant_name', 'amount', 'dept_name', 'title', 'item_name',
  'request_date', 'order_date', 'synced_at'];

async function readPending(token) {
  try {
    const q = '/rest/v1/purchase_requests?select=*&order_placed=eq.true&received=eq.false&order=synced_at.desc&limit=300';
    const { status, data } = await sb(q, { token });
    if (status !== 200 || !Array.isArray(data)) return { ok: false, rows: [] };
    const rows = data.map((o) => {
      const out = {};
      PENDING_FIELDS.forEach((k) => { if (o[k] !== undefined && o[k] !== null) out[k] = o[k]; });
      return out;
    });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, rows: [] };
  }
}

export default async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
  }

  // 로그인 확인 — 부서는 화면이 보낸 값이 아니라 계정에서 정합니다.
  const me = await verify(req);
  if (!me.ok) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });

  const year = String(req.query?.year || '').trim();

  try {
    const [{ rows, savedAt, error: blobError }, pending] = await Promise.all([readRows(), readPending(me.token)]);

    const allDepts = [...new Set(rows.map((r) => String(r.dept || '').trim()))].filter(Boolean).sort();
    const years = [...new Set(rows.map((r) => yearOf(r.date)))]
      .filter((y) => /^\d{4}$/.test(y)).sort().reverse();

    // 관리자(전략구매팀)만 ?dept= 로 다른 부서를 볼 수 있습니다.
    const asked = String(req.query?.dept || '').trim();
    const dept = me.isAdmin && asked ? asked : me.dept;

    // 계정 부서명과 구매 데이터 부서명 표기가 조금 달라도(띄어쓰기·가운뎃점) 같은 부서로 봅니다.
    const key = normDept(dept);
    let mine = rows.filter((r) => normDept(r.dept) === key);
    if (year) mine = mine.filter((r) => yearOf(r.date) === year);

    // 관리자가 다른 부서를 보면 GRFITI 목록도 그 부서로 좁힙니다(부서 칸이 있을 때만).
    let pendingRows = pending.rows;
    if (me.isAdmin && asked && pendingRows.some((p) => p.dept_name !== undefined)) {
      pendingRows = pendingRows.filter((p) => normDept(p.dept_name) === key);
    }

    // 요약은 서버에서 계산해 보냅니다. 화면이 가볍습니다.
    let totalAmt = 0, totalQty = 0;
    const byCategory = {};
    const byType = {};
    const byMonth = {};
    let lastDate = '';

    mine.forEach((r) => {
      const amt = Number(r.amt) || 0;
      totalAmt += amt;
      totalQty += Number(r.qty) || 0;

      const c = String(r.category || '미분류');
      byCategory[c] = (byCategory[c] || 0) + amt;

      const t = String(r.procurementType || '미지정');
      byType[t] = (byType[t] || 0) + amt;

      const m = String(r.date || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(m)) byMonth[m] = (byMonth[m] || 0) + amt;

      if (r.date && String(r.date) > lastDate) lastDate = String(r.date);
    });

    // 최근 건이 위로 오게.
    mine.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    return res.status(200).json({
      success: true,
      dept,
      me: { name: me.name, dept: me.dept, isAdmin: me.isAdmin },
      depts: me.isAdmin ? allDepts : [],
      years,
      pending: { ok: pending.ok, count: pendingRows.length, rows: pendingRows },
      year: year || '전체',
      savedAt,
      blobError: blobError || '',
      count: mine.length,
      totalAmt,
      totalQty,
      lastDate,
      byCategory,
      byType,
      byMonth,
      rows: mine
    });
  } catch (error) {
    const status = error?.status || error?.statusCode || error?.cause?.status;
    const message = String(error?.message || '').toLowerCase();
    if (status === 404 || message.includes('404') || message.includes('not found')) {
      return res.status(200).json({ success: true, dept: me.dept,
        me: { name: me.name, dept: me.dept, isAdmin: me.isAdmin },
        depts: [], years: [], rows: [], count: 0, totalAmt: 0, byCategory: {},
        pending: { ok: false, count: 0, rows: [] } });
    }
    console.error('[dept api error]', error);
    return res.status(500).json({ success: false, message: '조회 중 오류가 발생했습니다.' });
  }
}
