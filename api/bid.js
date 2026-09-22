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
      const s = e?.status || e?.statusCode || e?.cause?.status;
      const m = String(e?.message || '').toLowerCase();
      if (s === 404 || m.includes('404') || m.includes('not found')) throw e;
      last = e;
    }
  }
  throw last || new Error('Blob 자격을 찾지 못했습니다.');
}

/* 씨마켓 입찰구매 현황 — 배포 없이 갱신하기 위한 저장소
 *
 * 씨마켓(c-market.net)은 로그인 뒤에 있는 데이터라 서버가 직접 읽을 수 없습니다.
 * 그래서 사람이 넣은 숫자를 Blob 에 보관하고, 포털은 여기서 읽습니다.
 * Blob 이 비었거나 연결 전이면 정적 파일 data/bid.json 으로 넘어갑니다.
 *
 * GET  : 현재 값
 * POST : 갱신 (본문에 kpi / failed / period)
 *        수정용 키가 필요합니다 — 환경변수 BID_EDIT_KEY.
 *        설정하지 않으면 POST 를 받지 않습니다(읽기 전용).
 */

const FILE_NAME = 'portal-bid.json';

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
  return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())}`;
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
    } catch (e) { /* 없거나 실패하면 정적 파일로 넘어갑니다 */ }

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
      const kpi = b.kpi || {};
      const reasons = Array.isArray(b?.failed?.reasons) ? b.failed.reasons : [];

      const payload = {
        asOf: String(b.asOf || nowKst()),
        period: String(b.period || ''),
        source: '씨마켓플레이스 · 나의 거래 요약',
        savedBy: String(b.savedBy || '').trim(),
        savedAt: nowKst(),
        kpi: {
          inProgress: Number(kpi.inProgress) || 0,
          closed: Number(kpi.closed) || 0,
          contracts: Number(kpi.contracts) || 0,
          cardPending: Number(kpi.cardPending) || 0,
          invoices: Number(kpi.invoices) || 0
        },
        failed: {
          total: Number(b?.failed?.total) || reasons.reduce((s, r) => s + (Number(r.count) || 0), 0),
          reasons: reasons.slice(0, 10).map((r) => ({
            label: String(r.label || '').slice(0, 60),
            count: Number(r.count) || 0
          }))
        }
      };

      await blobTry((opt) => put(FILE_NAME, JSON.stringify(payload), {
        access: 'private', contentType: 'application/json', allowOverwrite: true, ...opt
      }));

      return res.status(200).json({ success: true, ...payload });
    } catch (error) {
      console.error('[bid api]', error);
      return res.status(500).json({ success: false, message: error.message || '저장 실패' });
    }
  }

  return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
}
