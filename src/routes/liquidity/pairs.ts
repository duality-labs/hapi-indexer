import { Request, ResponseToolkit } from '@hapi/hapi';

import {
  DataRow,
  getHeightedTokenPairsLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairsLiquidity';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';
import processRequest from '../../mechanisms';
import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';
import { Plugins } from './plugin';

const shape = ['rank', ['token0', 'token1', 'reserves0', 'reserves1']] as const;
type Shape = typeof shape;
type DataSets = [Array<DataRow>];

const defaultPaginationLimit = 10000;

const routes = [
  {
    method: 'GET',
    path: '/liquidity/pairs',
    handler: async (request: Request, h: ResponseToolkit) => {
      return processRequest<Plugins, DataSets, Shape>(request, h, {
        shape,
        getData,
        getPaginatedResponse,
        compressResponses: true,
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
  const data = await getHeightedTokenPairsLiquidity(query, context);
  if (data) {
    const [height, tokenPairsLiquidity] = data;
    return [height, tokenPairsLiquidity];
  }
  return null;
};

const getPaginatedResponse: GetEndpointResponse<DataSets, Shape> = (
  data,
  query
) => {
  const [, tokenPairsLiquidity = []] = data || [];
  // paginate the data
  const [page, pagination] = paginateData(
    tokenPairsLiquidity,
    query, // the time extents and frequency and such
    defaultPaginationLimit
  );
  return {
    data: page,
    pagination: pagination,
  };
};
