import { Request, ResponseToolkit } from '@hapi/hapi';

import processRequest from '../../mechanisms';
import { getUnsortedPairPriceTimeseries } from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';

import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';
import { Plugins } from '.';
import { days } from '../../storage/sqlite3/db/timeseriesUtils';
import hasInvertedOrder from '../../storage/sqlite3/db/dex.pairs/hasInvertedOrder';
import { getLastBlockHeight } from '../../sync';

// todo: remove seemingly useless array around volatility data
//       when the front end has this refactored the previous logic of timeseries
const shape = [['time_unix', ['volatility']]] as const;
type Shape = typeof shape;
type DataRow = [time_unix: number, volatility: [number]];
type DataSets = [Array<DataRow>];

const routes = [
  {
    method: 'GET',
    path: '/stats/volatility/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      return processRequest<Plugins, DataSets, Shape>(request, h, {
        shape,
        getData,
        getPaginatedResponse,
      });
    },
  },
];

export default routes;

const getData: GetEndpointData<Plugins, DataSets> = async (
  params,
  query,
  context
) => {
  const currentHeight = getLastBlockHeight();

  // round down to the passing of the most recent minute for "now"
  const now = new Date().setSeconds(0, 0).valueOf();
  const nowUnix = now / 1000;

  const dataPromise = getUnsortedPairPriceTimeseries(
    context.pairPriceCache,
    params['tokenA'],
    params['tokenB'],
    'day',
    {
      'pagination.before': `${nowUnix}`,
      'pagination.after': `${nowUnix - 22 * days}`,
    }
  );

  const invertedOrderPromise = hasInvertedOrder(
    params['tokenA'],
    params['tokenB']
  );

  const [data, invertedOrder] = await Promise.all([
    dataPromise.then((v) => (v === null ? [] : v)),
    invertedOrderPromise,
  ]);

  // respond that the pair has no volatility data
  if (!data) {
    return null;
  }
  const [, lastest22Days] = data;

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
  const last10Days: DataRow | null =
    priceChanges.length >= 10 || query['strict'] === 'false'
      ? [
          startOfTodayUnix - 10 * days,
          [annualFactor * standardDeviation(priceChanges.slice(0, 10))],
        ]
      : null;
  const last20Days: DataRow | null =
    priceChanges.length >= 20 || query['strict'] === 'false'
      ? [
          startOfTodayUnix - 20 * days,
          [annualFactor * standardDeviation(priceChanges.slice(10, 20))],
        ]
      : null;
  return [
    // replace the height ID of the response (which may be rounded down
    // to the nearest minute), which is confusing for this stat
    currentHeight,
    last10Days ? (last20Days ? [last10Days, last20Days] : [last10Days]) : [],
  ];
};

const getPaginatedResponse: GetEndpointResponse<DataSets, Shape> = (data) => {
  // return data as is without height
  const [, dataset] = data || [];
  return { data: dataset };
};

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
