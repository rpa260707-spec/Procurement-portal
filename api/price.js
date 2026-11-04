// 소모품 가격검색 요약 — 포털에서 쓰는 집계 전용 API
//
// price-sand 앱은 데이터를 페이지 안(인라인 스크립트)에 담고 있고 따로 API가 없습니다.
// (배포된 /api/store 는 501 을 돌려줍니다.)
// 브라우저에서 바로 읽으면 CORS 에 막히므로, 포털의 서버 함수가 대신 받아서
// 숫자만 세어 돌려줍니다. 가격·품명 같은 본문은 내보내지 않습니다.
//
// ⚠️ 앱 화면의 「4,147개 품목」은 발주이력과 단가표를 앱 자체 규칙으로 합친 값이라
//    바깥에서 똑같이 재현할 수 없습니다. 여기서는 확실히 셀 수 있는 값만 냅니다.
//    price-sand 에 /api/summary 가 생기면 이 파일은 그걸 그대로 중계하면 됩니다.

const SOURCE = 'https://price-sand.vercel.app/';

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // 10분 캐시 — 2MB짜리 페이지를 자주 받지 않도록 합니다.
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
}

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

export default async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
  }

  try {
    const r = await fetch(SOURCE, { headers: { 'User-Agent': 'fiti-portal' } });
    if (!r.ok) throw new Error('source ' + r.status);

    const html = await r.text();

    /* 「자료 올리기」로 서버에 올라온 발주 이력이 있으면 그것이 최신입니다.
       페이지 안에 박힌 값은 올린 뒤에도 그대로라 먼저 이쪽을 봅니다.
       못 읽거나 비어 있으면 아래 옛 방식(페이지 긁기)으로 돌아갑니다. */
    let up = null;
    try {
      const pr = await fetch(SOURCE + 'api/purchases', {
        headers: { 'User-Agent': 'fiti-portal' }, cache: 'no-store'
      });
      if (pr.ok) {
        const j = await pr.json();
        if (j && Array.isArray(j.rows) && j.rows.length) up = j;
      }
    } catch (e) { /* 옛 방식으로 */ }

    // 발주 이력이 있는 품목 — 각 레코드의 "k" 키 개수와 정확히 일치합니다.
    const ordered = up
      ? up.rows.length
      : new Set([...html.matchAll(/"k":"([^"]+)"/g)].map((m) => m[1])).size;

    // 단가 정보를 가진 전체 품목코드 (발주이력 + 단가표)
    const codeSet = new Set([...html.matchAll(/"code":"([^"]+)"/g)].map((m) => m[1]));
    if (up) up.rows.forEach((x) => { if (x.code) codeSet.add(x.code); });
    const codes = codeSet.size;

    const y2026 = up
      ? up.rows.filter((x) => x.y && x.y['2026']).length
      : countMatches(html, /"2026":\[/g);

    /* 품목별 발주 기록을 훑어 상위 목록을 만듭니다.
       페이지 안 레코드 형태:
         "k":"B040043205","code":"...","name":"와이프올 …","n":150,"qty":1452,
         "amt":37625080,"first":"2024-03-28","last":"2026-08-25","lp":24990
       n = 발주 횟수 · qty = 수량 · amt = 누적 금액 · lp = 최근 단가 */
    const REC = /"k":"([^"]+)","code":"[^"]*","name":"((?:[^"\\]|\\.)*)","n":(\d+),"qty":(-?\d+),"amt":(-?\d+),"first":"([^"]*)","last":"([^"]*)","lp":(-?\d+),"mn":-?\d+,"mx":-?\d+,"ven":"((?:[^"\\]|\\.)*)","vn":\d+,"biz":"([^"]*)","kind":"([^"]*)"/g;

    /* 품목 종류(kind) : 소모품 2,205 · 시약 1,565 · 인쇄물 72 · 가스 51 · 공기구비품 5
       `공기구비품` 은 시험장비 · 데스크탑 · 모니터 묶음이라 소모품 통계에서 뺍니다.
       (여기에 「어린이놀이기구 시험장비 3.2억」 같은 건이 들어 있어 순위를 왜곡했습니다) */
    const KEEP = ['소모품', '시약', '가스', '인쇄물'];

    const recs = [];
    let m;
    if (up) {
      for (const x of up.rows) {
        if (!KEEP.includes(x.kind || '')) continue;
        recs.push({
          code: x.code || '',
          name: x.name || '',
          count: Number(x.n) || 0,
          qty: Number(x.qty) || 0,
          amount: Number(x.amt) || 0,
          last: x.last || '',
          unitPrice: Number(x.lp) || 0,
          vendor: x.ven || '',
          kind: x.kind
        });
      }
    }
    while (!up && (m = REC.exec(html)) !== null) {
      const kind = m[11] || '';
      if (!KEEP.includes(kind)) continue;

      recs.push({
        code: m[1],
        name: m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
        count: Number(m[3]) || 0,   // 발주 횟수
        qty: Number(m[4]) || 0,
        amount: Number(m[5]) || 0,
        last: m[7] || '',
        unitPrice: Number(m[8]) || 0,
        vendor: (m[9] || '').replace(/\\"/g, '"'),
        kind
      });
    }

    const trim = (r) => ({
      code: r.code,
      name: r.name.length > 120 ? r.name.slice(0, 119) + '…' : r.name,
      kind: r.kind,
      vendor: r.vendor,
      count: r.count,
      qty: r.qty,
      amount: r.amount,
      last: r.last,
      unitPrice: r.unitPrice
    });

    // 자주 사는 품목 — 발주 횟수 상위 30개를 추린 뒤 **단가 높은 순**으로 보여 줍니다.
    const byCount = [...recs]
      .sort((a, b) => b.count - a.count)
      .slice(0, 30)
      .sort((a, b) => b.unitPrice - a.unitPrice)
      .slice(0, 8)
      .map(trim);

    // 단가 높은 품목 (최근 단가 기준)
    const byPrice = [...recs].sort((a, b) => b.unitPrice - a.unitPrice).slice(0, 8).map(trim);

    // 누적 발주액 큰 품목
    const byAmount = [...recs].sort((a, b) => b.amount - a.amount).slice(0, 8).map(trim);

    const byLast = [...recs].sort((a, b) => String(b.last).localeCompare(String(a.last))).slice(0, 8).map(trim);

    const totalAmount = recs.reduce((s, r) => s + r.amount, 0);

    return res.status(200).json({
      success: true,
      source: SOURCE,
      asOf: up ? (up.asOf || '') : '',   // 올린 자료의 기준일(없으면 빈 값)
      fromUpload: !!up,
      ordered,   // 발주 이력 품목 수
      codes,     // 단가 정보 보유 품목코드 수
      y2026,     // 26년 발주 실적이 있는 품목 수
      totalAmount,
      expensive: byPrice,  // 단가 높은 품목
      frequent: byCount,   // 자주 사는 품목 (단가 높은 순)
      biggest: byAmount,   // 누적 발주액 큰 품목
      recent: byLast       // 최근 발주 품목
    });
  } catch (error) {
    console.error('[price summary error]', error);
    return res.status(502).json({ success: false, message: '가격검색 사이트를 읽지 못했습니다.' });
  }
}
