import { Request, ResponseToolkit } from '@hapi/hapi';

import processRequest from '../../mechanisms';
import {
  getUnsortedPairPriceTimeseries,
  PairPriceTimeseries,
} from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';

import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';
import { Plugins } from '.';
import { hours } from '../../storage/sqlite3/db/timeseriesUtils';

const shape = ['time_unix', ['open', 'high', 'low', 'close']] as const;
type Shape = typeof shape;
type DataSets = [PairPriceTimeseries];

const routes = [
  {
    method: 'GET',
    path: '/stats/price/{tokenA}/{tokenB}',
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
  // round down to the passing of the most recent minute
  const mostRecentMinuteUnix = new Date().setSeconds(0, 0) / 1000;
  return getUnsortedPairPriceTimeseries(
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
};

const getPaginatedResponse: GetEndpointResponse<DataSets, Shape> = (data) => {
  // return data as is without height
  const [, dataset] = data || [];
  return { data: dataset };
};
