import sql from 'sql-template-strings';
import { Policy, PolicyOptions } from '@hapi/catbox';
import { inMs, minutes, seconds } from '../../db/timeseriesUtils';
import db from '../../db/db';

const { COIN_GECKO_PRO_API_KEY, COIN_GECKO_DEMO_API_KEY } = process.env;

interface CoinGeckoSimplePrice {
  usd: number;
  last_updated_at: number; // unix timestamp
}
export interface CoinGeckoSimplePriceResponse {
  [coingecko_id: string]: CoinGeckoSimplePrice;
}

export type CoinPriceCache = Policy<
  CoinGeckoSimplePriceResponse,
  PolicyOptions<CoinGeckoSimplePriceResponse>
>;

const expectedCacheTime = COIN_GECKO_PRO_API_KEY
  ? // Pro API keys have high 500K+ requests/month: use freshness limit
    30 * seconds * inMs
  : // Demo API keys have 10K requests/month: use under request limit
    15 * minutes * inMs;

let lastCoinPriceCacheResult: CoinGeckoSimplePriceResponse = {};
export const coinPriceCache: PolicyOptions<CoinGeckoSimplePriceResponse> = {
  // allow data to be replaced at expectedCacheTime, but return stale data quick
  staleIn: expectedCacheTime,
  staleTimeout: 1 * seconds * inMs,
  // allow return of stale data for a while after (in case of network failures)
  expiresIn: expectedCacheTime * 2,
  generateFunc: async (): Promise<CoinGeckoSimplePriceResponse> => {
    // get all CoinGecko IDs known to the dex
    const rows = await db.get<Array<{ coingecko_id: string }>>(
      sql`
        SELECT
          'dex.tokens'.'coingecko_id'
        FROM
          'dex.tokens'
        WHERE
          'dex.tokens'.'coingecko_id' IS NOT NULL
      `
    );
    if (rows && rows.length > 0) {
      const coingeckoIDs = rows.map((row) => row.coingecko_id);

      // construct CoinGecko query from IDs
      const queryParams = new URLSearchParams({
        ids: coingeckoIDs.join(','),
        vs_currencies: 'usd',
        include_last_updated_at: '',
      });
      const url = `${
        COIN_GECKO_PRO_API_KEY
          ? 'https://pro-api.coingecko.com/api/v3'
          : 'https://api.coingecko.com/api/v3'
      }/simple/price?${queryParams}`;
      const headers = {
        ...(COIN_GECKO_PRO_API_KEY
          ? { 'x-cg-pro-api-key': COIN_GECKO_PRO_API_KEY }
          : COIN_GECKO_DEMO_API_KEY && {
              'x-cg-demo-api-key': COIN_GECKO_DEMO_API_KEY,
            }),
      };

      // fetch Coin Gecko prices
      try {
        const response = await fetch(url, { headers });
        if (response.status === 200) {
          lastCoinPriceCacheResult =
            (await response.json()) as CoinGeckoSimplePriceResponse;
        }
      } catch (e) {
        // log the error
        // but simply continue to provide last known value as a fallback
        // eslint-disable-next-line no-console
        console.error(`Could not fetch CoinGecko prices for ${url}`, e);
      }
    }
    return lastCoinPriceCacheResult;
  },
  generateTimeout: 30 * seconds * inMs,
};

// this function continually caches all token price requests
// so that price and USD volume data can be used as a sorting metric
export async function getTokenPrices(
  coinPriceCache: CoinPriceCache
): Promise<CoinGeckoSimplePriceResponse> {
  const response = await coinPriceCache.get('');
  if (response) {
    // format of response was chosen using `getDecoratedValue: false`
    return response as CoinGeckoSimplePriceResponse;
  }
  // return last known result (may be empty)
  return lastCoinPriceCacheResult;
}
