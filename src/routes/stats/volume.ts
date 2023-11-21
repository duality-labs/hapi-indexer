import { Request, ResponseToolkit } from '@hapi/hapi';

import processRequest from '../../mechanisms';
import {
  getUnsortedSwapVolumeTimeseries,
  SwapVolumeTimeseries,
} from '../../storage/sqlite3/db/event.TickUpdate/getSwapVolume';
import {
  getUnsortedTotalVolumeTimeseries,
  TotalVolumeTimeseries,
} from '../../storage/sqlite3/db/derived.tx_volume_data/getTotalVolume';
import { hours } from '../../storage/sqlite3/db/timeseriesUtils';
import { Plugins } from '.';

const routes = [
  {
    method: 'GET',
    path: '/stats/volume/{tokenA}/{tokenB}/{resolution?}',
    handler: async (request: Request, h: ResponseToolkit) => {
      const shape = [
        'time_unix',
        [
          `amount ${request.params['tokenA']}`,
          `amount ${request.params['tokenB']}`,
          `fee ${request.params['tokenA']}`,
          `fee ${request.params['tokenB']}`,
        ],
      ] as const;
      return processRequest<Plugins, [SwapVolumeTimeseries], typeof shape>(
        request,
        h,
        {
          shape,
          getData: async (params, query, context) => {
            // round down to the passing of the most recent minute
            const mostRecentMinuteUnix = new Date().setSeconds(0, 0) / 1000;
            return getUnsortedSwapVolumeTimeseries(
              context.swapVolumeCache,
              params['tokenA'],
              params['tokenB'],
              'day',
              {
                'pagination.before': `${mostRecentMinuteUnix}`,
                'pagination.after': `${mostRecentMinuteUnix - 48 * hours}`,
              },
              'last24Hours'
            );
          },
          getPaginatedResponse: (data) => {
            // return data as is without height
            const [, dataset] = data || [];
            return { data: dataset };
          },
        }
      );
    },
  },
  {
    method: 'GET',
    path: '/stats/tvl/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      const shape = [
        'time_unix',
        [
          `amount ${request.params['tokenA']}`,
          `amount ${request.params['tokenB']}`,
        ],
      ] as const;
      return processRequest<Plugins, [TotalVolumeTimeseries], typeof shape>(
        request,
        h,
        {
          shape,
          getData: async (params, query, context) => {
            // round down to the passing of the most recent minute
            const mostRecentMinuteUnix = new Date().setSeconds(0, 0) / 1000;
            return getUnsortedTotalVolumeTimeseries(
              context.totalVolumeCache,
              params['tokenA'],
              params['tokenB'],
              'day',
              {
                'pagination.before': `${mostRecentMinuteUnix}`,
                'pagination.after': `${mostRecentMinuteUnix - 48 * hours}`,
              },
              'last24Hours'
            );
          },
          getPaginatedResponse: (data) => {
            // return data as is without height
            const [, dataset] = data || [];
            return { data: dataset };
          },
        }
      );
    },
  },
];

export default routes;
