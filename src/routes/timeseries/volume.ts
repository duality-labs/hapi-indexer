import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getSwapVolumePerSecond from '../../storage/sqlite3/db/derived.tx_price_data/getSwapVolumePerSecond';
import getTotalVolume from '../../storage/sqlite3/db/derived.tx_price_data/getTotalVolume';

import { accumulateDataSorted } from './utils';
import { DataRow } from '../../storage/sqlite3/db/derived.tx_price_data/getSwapVolumePerSecond';

type Data = Array<DataRow>;

const routes = [
  {
    method: 'GET',
    path: '/timeseries/volume/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const { shape, data: volumePerSecond } = await getSwapVolumePerSecond(
          request.params['tokenA'],
          request.params['tokenB'],
          request.query // the time extents and frequency and such
        );

        const volumePerHour = volumePerSecond.reduceRight<Data>(
          (data, [timeUnix, amounts]) => {
            const date = new Date(timeUnix * 1000);
            date.setSeconds(0);
            date.setMinutes(0);
            return accumulateDataSorted(data, [date.valueOf() / 1000, amounts]);
          },
          []
        );

        const volumePerDay = volumePerHour.reduceRight<Data>(
          (data, [timeUnix, amounts]) => {
            const date = new Date(timeUnix * 1000);
            date.setHours(0);
            return accumulateDataSorted(data, [date.valueOf() / 1000, amounts]);
          },
          []
        );

        const volumePerWeek = volumePerDay.reduceRight<Data>(
          (data, [timeUnix, amounts]) => {
            const date = new Date(timeUnix * 1000);
            const dayOfWeek = date.getDay();
            // set day of month to first of a week by using dayOfWeek
            date.setDate(date.getDate() - dayOfWeek);
            return accumulateDataSorted(data, [date.valueOf() / 1000, amounts]);
          },
          []
        );

        return {
          '24H': {
            shape,
            resolution: 'hour',
            data: volumePerHour.slice(0, 24),
          },
          '1W': {
            shape,
            resolution: 'hour',
            data: volumePerHour.slice(0, 24 * 7),
          },
          '1M': { shape, resolution: 'day', data: volumePerDay.slice(0, 28) },
          '1Y': { shape, resolution: 'week', data: volumePerWeek.slice(0, 52) },
          ALL:
            volumePerWeek.length > 52
              ? { shape, resolution: 'week', data: volumePerWeek }
              : volumePerDay.length > 28
              ? { shape, resolution: 'day', data: volumePerDay }
              : { shape, resolution: 'hour', data: volumePerHour },
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
    path: '/timeseries/tvl/{tokenA}/{tokenB}/{resolution?}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        return await getTotalVolume(
          request.params['tokenA'],
          request.params['tokenB'],
          request.params['resolution'],
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
