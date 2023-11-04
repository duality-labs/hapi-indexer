import sql from 'sql-template-strings';
import { Policy, PolicyOptions } from '@hapi/catbox';
import { Asset } from '@chain-registry/types';
import { inMs, minutes, seconds } from '../../db/timeseriesUtils';
import db from '../../db/db';

const { COIN_GECKO_PRO_API_KEY, COIN_GECKO_DEMO_API_KEY } = process.env;

interface CoinGeckoSimplePrice {
  usd: number;
  last_updated_at: number; // unix timestamp
}
export interface TokenPrices {
  [tokenID: string]: CoinGeckoSimplePrice;
}

export type CoinPriceCache = Policy<TokenPrices, PolicyOptions<TokenPrices>>;

const expectedCacheTime = COIN_GECKO_PRO_API_KEY
  ? // Pro API keys have high 500K+ requests/month: use freshness limit
    30 * seconds * inMs
  : // Demo API keys have 10K requests/month: use under request limit
    15 * minutes * inMs;

let lastCoinPriceCacheResult: TokenPrices = {};
export const coinPriceCache: PolicyOptions<TokenPrices> = {
  // allow data to be replaced at expectedCacheTime, but return stale data quick
  staleIn: expectedCacheTime,
  staleTimeout: 1 * seconds * inMs,
  // allow return of stale data for a while after (in case of network failures)
  expiresIn: expectedCacheTime * 2,
  generateFunc: async (): Promise<TokenPrices> => {
    // get all CoinGecko IDs known to the dex
    const rows = await db.all<Array<{ id: string; coingecko_id: string }>>(
      sql`
        SELECT
          'dex.tokens'.'id',
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
      // docs: https://www.coingecko.com/api/documentation
      const queryParams = new URLSearchParams({
        ids: coingeckoIDs.join(','),
        vs_currencies: 'usd',
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
        console.log('fetching from coin gecko:', url, headers)
        const response = await fetch(url, { headers });
        if (response.status === 200) {
          const data = (await response.json()) as {
            [coingeckoID: string]: CoinGeckoSimplePrice;
          };
          // put into TokenPrices format (non-CoinGecko specific)
          lastCoinPriceCacheResult = Object.entries(data).reduce(
            (acc, [coingeckoID, price]) => {
              const token = rows.find(
                (row) => row.coingecko_id === coingeckoID
              );
              if (token) {
                acc[token.id] = price;
              }
              return acc;
            },
            {} as TokenPrices
          );
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
): Promise<TokenPrices> {
  const response = await coinPriceCache.get('');
  if (response) {
    // format of response was chosen using `getDecoratedValue: false`
    return response as TokenPrices;
  }
  // return last known result (may be empty)
  return lastCoinPriceCacheResult;
}

export async function getTokenPrice(
  coinPriceCache: CoinPriceCache,
  asset: Asset
): Promise<CoinGeckoSimplePrice | undefined> {
  const coinPriceCacheResult = await getTokenPrices(coinPriceCache);
  return asset.coingecko_id
    ? coinPriceCacheResult[asset.coingecko_id]
    : undefined;
}
