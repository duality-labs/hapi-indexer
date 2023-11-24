import { Request, ResponseToolkit } from '@hapi/hapi';

import processRequest from '../../mechanisms';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';
import {
  getUnsortedSwapVolumeTimeseries,
  SwapVolumeTimeseries,
} from '../../storage/sqlite3/db/event.TickUpdate/getSwapVolume';
import {
  getUnsortedTotalVolumeTimeseries,
  TotalVolumeTimeseries,
} from '../../storage/sqlite3/db/derived.tx_volume_data/getTotalVolume';

import { Plugins } from '.';

const defaultPaginationLimit = 100;

const routes = [
  {
    method: 'GET',
    path: '/timeseries/volume/{tokenA}/{tokenB}/{resolution?}',
    handler: async (request: Request, h: ResponseToolkit) => {
      const shape = [
        [
          'time_unix',
          [
            `amount ${request.params['tokenA']}`,
            `amount ${request.params['tokenB']}`,
            `fee ${request.params['tokenA']}`,
            `fee ${request.params['tokenB']}`,
          ],
        ],
      ] as const;
      return processRequest<Plugins, [SwapVolumeTimeseries], typeof shape>(
        request,
        h,
        {
          shape,
          getData: async (params, query, context) => {
            const result = await getUnsortedSwapVolumeTimeseries(
              context.swapVolumeCache,
              params['tokenA'],
              params['tokenB'],
              params['resolution'],
              query // the time extents and frequency and such
            );
            return result;
          },
          getPaginatedResponse: (data, query) => {
            const [, datasets = []] = data || [];
            // paginate the data
            const [page, pagination] = paginateData(
              datasets,
              query, // the time extents and frequency and such
              defaultPaginationLimit
            );
            return {
              data: page,
              pagination: pagination,
            };
          },
        }
      );
    },
  },

  {
    method: 'GET',
    path: '/timeseries/tvl/{tokenA}/{tokenB}/{resolution?}',
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
            const result = await getUnsortedTotalVolumeTimeseries(
              context.totalVolumeCache,
              params['tokenA'],
              params['tokenB'],
              params['resolution'],
              query // the time extents and frequency and such
            );
            return result;
          },
          getPaginatedResponse: (data, query) => {
            const [, datasets = []] = data || [];
            // paginate the data
            const [page, pagination] = paginateData(
              datasets,
              query, // the time extents and frequency and such
              defaultPaginationLimit
            );
            return {
              data: page,
              pagination: pagination,
            };
          },
        }
      );
    },
  },
];

export default routes;
