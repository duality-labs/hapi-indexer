import { Request, ResponseToolkit } from '@hapi/hapi';

import processRequest from '../../mechanisms';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';
import {
  getUnsortedPairPriceTimeseries,
  PairPriceTimeseries,
} from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';

import { hours } from '../../storage/sqlite3/db/timeseriesUtils';
import { getLastBlockHeight } from '../../sync';

import { Plugins } from './plugin';

const shape = ['time_unix', ['open', 'high', 'low', 'close']] as const;
type Shape = typeof shape;
type DataSets = [PairPriceTimeseries];

const defaultPaginationLimit = 100;

const routes = [
  {
    method: 'GET',
    path: '/timeseries/price/{tokenA}/{tokenB}/{resolution?}',
    handler: async (request: Request, h: ResponseToolkit) => {
      return processRequest<Plugins, DataSets, Shape>(request, h, {
        shape,
        getData: async (params, query, context) => {
          const result = await getUnsortedPairPriceTimeseries(
            context.pairPriceCache,
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
      });
    },
  },
  {
    method: 'GET',
    path: '/stats/price/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      return processRequest<Plugins, DataSets, Shape>(request, h, {
        shape,
        getData: async (params, query, context) => {
          const currentHeight = getLastBlockHeight();

          // round down to the passing of the most recent minute
          const mostRecentMinuteUnix = new Date().setSeconds(0, 0) / 1000;
          const response = await getUnsortedPairPriceTimeseries(
            context.pairPriceCache,
            params['tokenA'],
            params['tokenB'],
            'day',
            {
              'pagination.before': `${mostRecentMinuteUnix}`,
              'pagination.after': `${mostRecentMinuteUnix - 48 * hours}`,
            },
            'last24Hours'
          );
          // replace the height ID of the response (which may be rounded down
          // to the nearest minute), which is confusing for this stat
          if (response) {
            response[0] = currentHeight;
          }
          return response;
        },
        getPaginatedResponse: (data) => {
          // return data as is without height
          const [, dataset] = data || [];
          return { data: dataset };
        },
      });
    },
  },
];

export default routes;
