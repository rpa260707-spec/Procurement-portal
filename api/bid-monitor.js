import { put, get } from '@vercel/blob';

/* Vercel Blob 자격 찾기 — 연결 접두사가 붙어도(예: portal_STORE_ID) 동작하게 후보를 모읍니다. */
const BLOB_CANDIDATES = (() => {
  const out = [];
  const seen = new Set();
  const add = (o) => {
    const k = JSON.stringify(o);
    if (o && Object.keys(o).length && !seen.has(k)) { seen.add(k); out.push(o); }
  };
  if (process.env.BLOB_READ_WRITE_TOKEN) add({ token: process.env.BLOB_READ_WRITE_TOKEN });
  for (const n of Object.keys(process.env)) {
    if (n.endsWith('_READ_WRITE_TOKEN') && process.env[n]) add({ token: process.env[n] });
  }
  if (process.env.BLOB_STORE_ID) add({ storeId: process.env.BLOB_STORE_ID });
  for (const n of Object.keys(process.env)) {
    if (n.endsWith('_STORE_ID') && process.env[n]) add({ storeId: process.env[n] });
  }
  add({});
  return out;
})();

let BLOB_OK = null;

async function blobTry(run) {
  const list = BLOB_OK ? [BLOB_OK, ...BLOB_CANDIDATES] : BLOB_CANDIDATES;
  let last;
  for (const opt of list) {
    try {
      const r = await run(opt);
      BLOB_OK = opt;
      return r;
    } catch (e) {
      const st = e?.status || e?.statusCode || e?.cause?.status;
      const m = String(e?.message || '').toLowerCase();
      if (st === 404 || m.includes('404') || m.includes('not found')) throw e;
      last = e;
    }
  }
  throw last || new Error('Blob 자격을 찾지 못했습니다.');
}

/* 입찰-소모품 누락 모니터링 — 배포 없이 갱신하기 위한 저장소
 *
 * 그룹웨어(gw.fiti.re.kr CDTS5122)는 로그인 쿠키가 있어야 읽히므로 서버가 직접 못 부릅니다.
 * 로그인된 브라우저에서 수집 스크립트를 돌려 여기로 POST 하고, 포털은 여기서 읽습니다.
 * Blob 이 비었거나 연결 전이면 포털이 정적 파일 data/bid-monitor.json 으로 넘어갑니다.
 *
 * GET  : 현재 값
 * POST : 갱신 (본문에 notSent / stalled / failed 배열)
 *        수정용 키가 필요합니다 — 환경변수 BID_EDIT_KEY (씨마켓과 같은 키).
 *
 * 개인정보는 담지 않습니다. 담당자는 이름만 받고 사번·연락처·금액은 저장하지 않습니다.
 */

const FILE_NAME = 'portal-bid-monitor.json';
const KEYS = ['notSent', 'stalled', 'failed'];
const MAX_ROWS = 300;   // 탭당 상한. 통째로 넘어와도 응답이 비대해지지 않게 자릅니다.
const MAX_DAYS = 14;    // 경과 14일 초과는 담지 않습니다 — 따로 사유가 있는 건이라 보고 제외합니다.
/* 단, 「유찰」은 기간을 안 자릅니다. 지난 유찰까지 한눈에 봐야 해서입니다.
   입찰 누락·마감 후 정체만 14일 컷을 겁니다. */
const NO_CUT = new Set(['failed']);

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Edit-Key');
  res.setHeader('Cache-Control', 'no-store');
}

async function streamToText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function nowKst() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return kst.getUTCFullYear() + '-' + p(kst.getUTCMonth() + 1) + '-' + p(kst.getUTCDate());
}

const s = (v, n) => String(v ?? '').trim().slice(0, n);

/* 화면에서 긁어온 값이라 뭐가 들어올지 모릅니다. 쓰는 칸만 남기고 길이도 자릅니다. */
function cleanRow(r) {
  return {
    days:  Math.max(0, Math.min(9999, Number(r?.days) || 0)),
    prNo:  s(r?.prNo, 30),
    item:  s(r?.item, 120),
    dept:  s(r?.dept, 30),
    emp:   s(r?.emp, 20),
    endDt: s(r?.endDt, 20),
    step:  s(r?.step, 30)
  };
}

export default async function handler(req, res) {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    try {
      const blob = await blobTry((opt) => get(FILE_NAME, { access: 'private', ...opt }));
      if (blob && blob.stream) {
        const text = await streamToText(blob.stream);
        if (text) return res.status(200).json({ success: true, from: 'blob', ...JSON.parse(text) });
      }
    } catch (e) { /* 없거나 실패하면 포털이 정적 파일로 넘어갑니다 */ }

    return res.status(200).json({ success: true, from: 'file', fallback: true });
  }

  if (req.method === 'POST') {
    const key = process.env.BID_EDIT_KEY;
    if (!key) {
      return res.status(403).json({ success: false, message: '수정 키(BID_EDIT_KEY)가 설정되지 않아 갱신할 수 없습니다.' });
    }
    if ((req.headers['x-edit-key'] || '') !== key) {
      return res.status(401).json({ success: false, message: '수정 키가 맞지 않습니다.' });
    }

    try {
      const b = req.body || {};
      const payload = {
        asOf: s(b.asOf, 10) || nowKst(),
        scope: s(b.scope, 60) || '입찰-소모품',
        totalRows: Math.max(0, Number(b.totalRows) || 0),
        savedBy: s(b.savedBy, 40),
        savedAt: nowKst(),
        counts: {}
      };

      for (const k of KEYS) {
        const rows = (Array.isArray(b[k]) ? b[k] : [])
          .map(cleanRow)
          .filter((r) => (r.prNo || r.item) && (NO_CUT.has(k) || r.days <= MAX_DAYS))
          .sort((x, y) => x.days - y.days)      // 최근 마감일이 위로
          .slice(0, MAX_ROWS);
        payload[k] = rows;
        payload.counts[k] = rows.length;
      }

      await blobTry((opt) => put(FILE_NAME, JSON.stringify(payload), {
        access: 'private', contentType: 'application/json', allowOverwrite: true, ...opt
      }));

      return res.status(200).json({ success: true, counts: payload.counts, asOf: payload.asOf });
    } catch (error) {
      console.error('[bid-monitor api]', error);
      return res.status(500).json({ success: false, message: error.message || '저장 실패' });
    }
  }

  return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
}
