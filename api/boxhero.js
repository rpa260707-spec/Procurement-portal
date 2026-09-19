// 박스히어로 오늘 입출고 — 포털 위젯용 요약 API
//
// 왜 따로 만들었나
//   boxhero-dashboard 앱은 화면을 그리기 전에 /v1/items 를 100건씩 수십 번 받아옵니다.
//   (품목 수천 건 → 순차 호출 30회 이상) 그래서 첫 화면이 느립니다.
//   포털에 필요한 건 "오늘 무엇이 들어오고 나갔는가" 뿐이므로
//   여기서는 /v1/transactions 를 **한 번만** 부르고 오늘 것만 골라 냅니다.
//   품목 상세(/v1/transactions/{id})는 부르지 않습니다 — 그게 느림의 주범입니다.
//
// 토큰
//   Vercel 프로젝트 환경변수 BOXHERO_API_TOKEN 에 넣습니다.
//   토큰에는 쓰기 권한이 있으므로 HTML·소스에 절대 넣지 않습니다.
//   설정 후 반드시 Redeploy 해야 반영됩니다.

const BASE = 'https://rest.boxhero-app.com';
const TYPE_KO = { in: '입고', out: '출고', move: '이동', adjust: '조정' };

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // 5분 캐시 — 박스히어로 rate limit(429) 을 피합니다.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
}

// 한국 시간 기준 오늘 (YYYY-MM-DD)
function kstToday() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())}`;
}

function kstDate(iso) {
  if (!iso) return '';
  const kst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())}`;
}

function kstTime(iso) {
  if (!iso) return '';
  const kst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`;
}

export default async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
  }

  const token = process.env.BOXHERO_API_TOKEN;
  if (!token) {
    return res.status(200).json({
      success: false,
      reason: 'no-token',
      message: '박스히어로 토큰이 설정되지 않았습니다. Vercel 환경변수 BOXHERO_API_TOKEN 을 넣고 Redeploy 하세요.'
    });
  }

  try {
    // 거래는 최신순으로 내려오므로 한 페이지(100건)면 오늘 것은 거의 항상 포함됩니다.
    const r = await fetch(`${BASE}/v1/transactions?limit=100`, {
      headers: { Authorization: 'Bearer ' + token }
    });

    if (!r.ok) {
      let body = null;
      try { body = await r.json(); } catch (e) { /* 본문이 JSON 이 아닐 수 있습니다 */ }
      return res.status(200).json({
        success: false,
        reason: 'api-' + r.status,
        message: body?.title || ('박스히어로 API ' + r.status)
      });
    }

    const json = await r.json();
    const all = Array.isArray(json?.items) ? json.items : [];

    const today = kstToday();
    const rows = all.filter((t) => kstDate(t?.transaction_time) === today);

    let inCount = 0, outCount = 0, inQty = 0, outQty = 0;

    const recent = rows.slice(0, 5).map((t) => ({
      time: kstTime(t?.transaction_time),
      type: t?.type || '',
      typeLabel: TYPE_KO[t?.type] || String(t?.type || ''),
      kinds: Number(t?.count_of_items) || 0,
      qty: Number(t?.total_quantity) || 0,
      location: t?.to_location?.name || t?.from_location?.name || '',
      partner: t?.partner?.name || ''
    }));

    for (const t of rows) {
      const qty = Number(t?.total_quantity) || 0;
      if (t?.type === 'in') { inCount += 1; inQty += Math.abs(qty); }
      else if (t?.type === 'out') { outCount += 1; outQty += Math.abs(qty); }
    }

    // 오늘 거래가 없으면 마지막 거래가 언제였는지만 알려 줍니다.
    const lastDate = all.length ? kstDate(all[0]?.transaction_time) : '';

    return res.status(200).json({
      success: true,
      asOf: today,
      total: rows.length,
      inCount, outCount, inQty, outQty,
      recent,
      lastDate
    });
  } catch (error) {
    console.error('[boxhero summary error]', error);
    return res.status(200).json({ success: false, reason: 'fetch', message: '박스히어로에 연결하지 못했습니다.' });
  }
}
