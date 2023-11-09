import sql from 'sql-template-tag';
import { Policy, PolicyOptions } from '@hapi/catbox';
import { Plugin, ServerRegisterOptions } from '@hapi/hapi';

import db, { prepare } from '../storage/sqlite3/db/db';
import { inMs, minutes, seconds } from '../storage/sqlite3/db/timeseriesUtils';
import { GlobalPlugins } from '.';

import logger from '../logger';

const { COIN_GECKO_PRO_API_KEY, COIN_GECKO_DEMO_API_KEY } = process.env;

interface CoinGeckoSimplePrice {
  usd: number;
  last_updated_at: number; // unix timestamp
}
interface TokenPrices {
  [coingecko_id: string]: CoinGeckoSimplePrice;
}
type CoinPriceCache = Policy<TokenPrices, PolicyOptions<TokenPrices>>;

const name = 'cachedTokenPrices' as const;
export interface PluginContext {
  [name]: {
    get: () => Promise<TokenPrices>;
  };
}

const expectedCacheTime = COIN_GECKO_PRO_API_KEY
  ? // Pro API keys have high 500K+ requests/month: use freshness limit
    30 * seconds * inMs
  : // Demo API keys have 10K requests/month: use under request limit
    15 * minutes * inMs;

export const plugin: Plugin<ServerRegisterOptions> = {
  name,
  register: async function (server) {
    // create cache
    let lastCoinPriceCacheResult: TokenPrices = {};
    const cache: CoinPriceCache = server.cache({
      segment: 'token-prices',
      // allow data to be replaced at expectedCacheTime, but return stale data quick
      staleIn: expectedCacheTime,
      staleTimeout: 1 * seconds * inMs,
      // allow return of stale data for a while after (in case of network failures)
      expiresIn: expectedCacheTime * 2,
      generateFunc: async (): Promise<TokenPrices> => {
        // get all CoinGecko IDs known to the dex
        const rows = await db.all<Array<{ token: string }>>(
          ...prepare(sql`
            SELECT
              'dex.tokens'.'token'
            FROM
              'dex.tokens'
          `)
        );
        // get CoinGecko IDs from chain denom "token" strings
        const coingeckoIDs = await Promise.all(
          rows.map(async (row) => {
            const plugins = server.plugins as GlobalPlugins;
            // or dynamic asset but fallback to static asset if not available
            return await plugins.cachedAssets.getAsset(row.token, {
              defaultToStaticAsset: true,
            });
          })
        ).then((assets) =>
          assets
            .map((asset) => asset?.coingecko_id)
            .filter((id): id is string => !!id)
        );
        if (coingeckoIDs.length > 0) {
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
          const ids = coingeckoIDs.join(', ');
          const idsCount = coingeckoIDs.length;
          const logID = `${idsCount} prices: ${ids}`;
          try {
            logger.info(`CoinGecko: fetching ${logID}`);
            const response = await fetch(url, { headers });
            if (response.status === 200) {
              lastCoinPriceCacheResult = (await response.json()) as TokenPrices;
            } else {
              // note: 502 seem fairly common at least with a demo API key
              //       this might be the rate limiting
              throw new Error(`Unexpected responsed code: ${response.status}`);
            }
            logger.info(`CoinGecko:  fetched ${logID}`);
          } catch (e) {
            // log the error
            // but simply continue to provide last known value as a fallback
            logger.error(
              `CoinGecko: Could not fetch ${logID} (${
                // add request details, but don't expose keys
                `at ${url}, headers: ${Object.keys(headers).join(', ')}`
              }): ${(e as Error)?.message}`
            );
          }
        }
        return lastCoinPriceCacheResult;
      },
      generateTimeout: 30 * seconds * inMs,
    });
    // add cache method into response context
    const pluginContext: PluginContext['cachedTokenPrices'] = {
      get: async () => {
        return (await cache.get('')) ?? lastCoinPriceCacheResult;
      },
    };
    // add plugin context methods to plugin under server.plugin[pluginName][key]
    server.expose(pluginContext);
  },
};
