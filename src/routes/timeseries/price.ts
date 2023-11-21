import { Request, ResponseToolkit } from '@hapi/hapi';

import processRequest from '../../mechanisms';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';
import {
  getUnsortedPairPriceTimeseries,
  PairPriceTimeseries,
} from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';

import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';
import { Plugins } from '.';

const shape = [['time_unix', ['open', 'high', 'low', 'close']]] as const;
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
  const result = await getUnsortedPairPriceTimeseries(
    context.pairPriceCache,
    params['tokenA'],
    params['tokenB'],
    params['resolution'],
    query // the time extents and frequency and such
  );
  return result;
};

const getPaginatedResponse: GetEndpointResponse<DataSets, Shape> = (
  data,
  query
) => {
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
};
