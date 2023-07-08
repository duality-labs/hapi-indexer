import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getPrice from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';
import { days } from '../../storage/sqlite3/db/timeseriesUtils';
import hasInvertedOrder from '../../storage/sqlite3/db/dex.pairs/hasInvertedOrder';

const routes = [
  {
    method: 'GET',
    path: '/stats/volatility/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        // round down to the passing of the most recent second for "now"
        const now = Date.now();
        const nowUnix = new Date(now).setMilliseconds(0) / 1000;

        const dataPromise = getPrice(
          request.params['tokenA'],
          request.params['tokenB'],
          'day',
          {
            'pagination.limit': '22',
            'pagination.before': `${nowUnix}`,
          }
        );

        const invertedOrderPromise = hasInvertedOrder(
          request.params['tokenA'],
          request.params['tokenB']
        );

        const [{ data: lastest22Days }, invertedOrder] = await Promise.all([
          dataPromise,
          invertedOrderPromise,
        ]);

        // round down to the passing of the most recent day for calculations
        const startOfToday = new Date(now);
        startOfToday.setSeconds(0, 0);
        startOfToday.setMinutes(0);
        startOfToday.setHours(0);
        const startOfTodayUnix = startOfToday.valueOf() / 1000;

        // get close price of last 21 whole days (today has not closed)
        const closePriceOfLast21Days = Array.from({ length: 21 }).map<
          number | undefined
        >((_, index) => {
          // define day that we are looking for
          const startOfDayUnix = startOfTodayUnix - (index + 1) * days;
          // find the nearest matching data (some days may have no trading)
          // days with no exact match should match the nearest previous day
          const foundData = lastest22Days.find(([time_unix]) => {
            return time_unix <= startOfDayUnix;
          });
          // return close data for that day if possible
          if (foundData) {
            // extract out close data from found price index data
            const [, [, , , closeIndex]] = foundData;
            if (closeIndex !== null && closeIndex !== undefined) {
              const close = Math.pow(
                1.0001,
                invertedOrder ? -closeIndex : closeIndex
              );
              return close;
            }
          }
          // else return an empty price
        });

        // convert the close prices to relative close price changes
        const priceChanges = closePriceOfLast21Days.flatMap<number>(
          (previousClose, index, dayCloses) => {
            // skip first day
            if (index === 0) return [];
            // return price change data if we can
            const close = dayCloses[index - 1];
            const priceChange = Number(close) / Number(previousClose) - 1;
            return !isNaN(priceChange) ? priceChange : [];
          }
        );

        // calculate annualized volatility for each 10 day period.
        // use an annualization factor of 252 as Trading View uses 10d / 252d:
        // although the token is always live we compare it to trading stocks
        // which are on average open 252 days of the year
        const annualFactor = Math.sqrt(252);
        return {
          shape: ['time_unix', ['volatility']],
          data: [
            [
              startOfTodayUnix - 10 * days,
              priceChanges.length >= 10 || request.query['strict'] === 'false'
                ? [annualFactor * standardDeviation(priceChanges.slice(0, 10))]
                : [],
            ],
            [
              startOfTodayUnix - 20 * days,
              priceChanges.length >= 20 || request.query['strict'] === 'false'
                ? [annualFactor * standardDeviation(priceChanges.slice(-10))]
                : [],
            ],
          ],
        };
      } catch (err: unknown) {
        if (err instanceof Error) {
          logger.error(err);
          return h
            .response(`something happened: ${err.message || '?'}`)
            .code(500);
        }
        return h.response('An unknown error occurred').code(500);
      }
    },
  },
];

export default routes;

// from: https://github.com/30-seconds/30-seconds-of-code/blob/v8.0.0/snippets/js/s/standard-deviation.md
const standardDeviation = (arr: number[], usePopulation = false): number => {
  const mean = arr.reduce((acc, val) => acc + val, 0) / arr.length;
  return Math.sqrt(
    arr
      .reduce<number[]>((acc, val) => acc.concat((val - mean) ** 2), [])
      .reduce<number>((acc, val) => acc + val, 0) /
      (arr.length - (usePopulation ? 0 : 1))
  );
};
