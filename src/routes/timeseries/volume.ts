import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getSwapVolumePerSecond from '../../storage/sqlite3/db/derived.tx_price_data/getSwapVolumePerSecond';
import getTotalVolumePerSecond from '../../storage/sqlite3/db/derived.tx_price_data/getTotalVolumePerSecond';

interface DataRow {
  timestamp: string;
  tokenA: number;
  tokenB: number;
}
type Data = Array<DataRow>;

function accumulateData(data: Data, { timestamp, tokenA, tokenB }: DataRow) {
  const dataLast = data[data.length - 1];
  if (dataLast && dataLast.timestamp === timestamp) {
    if (tokenA) {
      dataLast.tokenA += tokenA;
    }
    if (tokenB) {
      dataLast.tokenB += tokenB;
    }
  } else {
    data.push({ timestamp, tokenA, tokenB });
  }
  return data;
}

const routes = [
  {
    method: 'GET',
    path: '/timeseries/volume/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const volumePerSecond = await getSwapVolumePerSecond(
          request.params['tokenA'],
          request.params['tokenB'],
          request.query // the time extents and frequency and such
        );

        const volumePerHour = volumePerSecond.data.reduceRight<Data>(
          (data, [timeUnix, amount, token]) => {
            const date = new Date(timeUnix * 1000);
            date.setMilliseconds(0);
            date.setSeconds(0);
            date.setMinutes(0);
            const row: DataRow = {
              timestamp: date.toISOString(),
              tokenA: token === request.params['tokenA'] ? amount : 0,
              tokenB: token === request.params['tokenB'] ? amount : 0,
            };
            return accumulateData(data, row);
          },
          []
        );

        const volumePerDay = volumePerHour.reduceRight<Data>(
          (data, { timestamp, tokenA, tokenB }) => {
            const date = new Date(timestamp);
            date.setHours(0);
            return accumulateData(data, {
              timestamp: date.toISOString(),
              tokenA,
              tokenB,
            });
          },
          []
        );

        const volumePerWeek = volumePerDay.reduceRight<Data>(
          (data, { timestamp, tokenA, tokenB }) => {
            const date = new Date(timestamp);
            const dayOfWeek = date.getDay();
            // set day of month to first of a week by using dayOfWeek
            date.setDate(date.getDate() - dayOfWeek);
            return accumulateData(data, {
              timestamp: date.toISOString(),
              tokenA,
              tokenB,
            });
          },
          []
        );

        return {
          '24H': { resolution: 'hour', data: volumePerHour.slice(0, 24) },
          '1W': { resolution: 'hour', data: volumePerHour.slice(0, 24 * 7) },
          '1M': { resolution: 'day', data: volumePerDay.slice(0, 28) },
          '1Y': { resolution: 'week', data: volumePerWeek.slice(0, 52) },
          ALL:
            volumePerWeek.length > 52
              ? { resolution: 'week', data: volumePerWeek }
              : volumePerDay.length > 28
              ? { resolution: 'day', data: volumePerDay }
              : { resolution: 'hour', data: volumePerHour },
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

  {
    method: 'GET',
    path: '/timeseries/tvl/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        return await getTotalVolumePerSecond(
          request.params['tokenA'],
          request.params['tokenB'],
          request.query // the time extents and frequency and such
        );
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
