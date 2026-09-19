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

    // 발주 이력이 있는 품목 — 각 레코드의 "k" 키 개수와 정확히 일치합니다.
    const ordered = new Set(
      [...html.matchAll(/"k":"([^"]+)"/g)].map((m) => m[1])
    ).size;

    // 단가 정보를 가진 전체 품목코드 (발주이력 + 단가표)
    const codes = new Set(
      [...html.matchAll(/"code":"([^"]+)"/g)].map((m) => m[1])
    ).size;

    const y2026 = countMatches(html, /"2026":\[/g);

    return res.status(200).json({
      success: true,
      source: SOURCE,
      ordered,   // 발주 이력 품목 수
      codes,     // 단가 정보 보유 품목코드 수
      y2026      // 26년 발주 실적이 있는 품목 수
    });
  } catch (error) {
    console.error('[price summary error]', error);
    return res.status(502).json({ success: false, message: '가격검색 사이트를 읽지 못했습니다.' });
  }
}
