// 업무포털 시세 위젯용 API
// 원/달러 환율, 100엔/원 환율, 국제 브렌트유를 한 번에 내려 줍니다.
//
// · 브라우저에서 외부 시세 사이트를 직접 부르면 CORS 에 막히므로 서버에서 대신 받아옵니다.
// · Vercel 엣지 캐시를 5분 걸어 두어 방문자가 많아도 원본을 자주 두드리지 않습니다.

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

const SYMBOLS = {
  usdkrw: 'USDKRW=X',   // 원/달러
  jpykrw: 'JPYKRW=X',   // 원/엔 (100엔 환산은 화면에서 처리)
  brent:  'BZ=F'        // 브렌트유 선물 (USD/배럴)
};

async function fetchYahoo(symbol) {
  const url = `${YAHOO}${encodeURIComponent(symbol)}?interval=1d&range=5d`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });

  if (!res.ok) throw new Error(`${symbol} ${res.status}`);

  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`${symbol} no meta`);

  const price = Number(meta.regularMarketPrice);
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
  if (!isFinite(price)) throw new Error(`${symbol} no price`);

  return {
    value: price,
    prev: isFinite(prev) ? prev : null,
    currency: meta.currency || '',
    at: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now()
  };
}

// 야후가 막히면 환율만이라도 살리기 위한 예비 소스
async function fetchFxFallback() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error('fx fallback ' + res.status);

  const j = await res.json();
  const krw = Number(j?.rates?.KRW);
  const jpy = Number(j?.rates?.JPY);
  if (!isFinite(krw) || !isFinite(jpy)) throw new Error('fx fallback no rates');

  return {
    usdkrw: { value: krw, prev: null, currency: 'KRW', at: Date.now() },
    jpykrw: { value: krw / jpy, prev: null, currency: 'KRW', at: Date.now() }
  };
}

export default async function handler(req, res) {
  // 5분 캐시 — 같은 값을 반복 요청해도 원본은 5분에 한 번만 호출됩니다.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const out = {};
  const failed = [];

  const results = await Promise.allSettled(
    Object.entries(SYMBOLS).map(async ([key, sym]) => [key, await fetchYahoo(sym)])
  );

  results.forEach((r, i) => {
    const key = Object.keys(SYMBOLS)[i];
    if (r.status === 'fulfilled') out[key] = r.value[1];
    else failed.push(key);
  });

  // 환율이 둘 다 실패하면 예비 소스로 한 번 더 시도합니다.
  if (!out.usdkrw || !out.jpykrw) {
    try {
      const fb = await fetchFxFallback();
      if (!out.usdkrw) { out.usdkrw = fb.usdkrw; }
      if (!out.jpykrw) { out.jpykrw = fb.jpykrw; }
    } catch (e) {
      // 예비 소스까지 실패하면 그대로 둡니다.
    }
  }

  const ok = Object.keys(out).length > 0;

  return res.status(ok ? 200 : 502).json({
    success: ok,
    data: out,
    failed,
    fetchedAt: Date.now()
  });
}
