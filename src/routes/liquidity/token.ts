import { Request, ResponseToolkit } from '@hapi/hapi';

import {
  DataRowA,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairLiquidity';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';
import processRequest from '../../mechanisms';
import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';
import { Plugins } from '.';

const shape = [['tick_index_b_to_a', 'reserves']] as const;
type Shape = typeof shape;
type DataSets = [Array<DataRowA>];

const defaultPaginationLimit = 10000;

const routes = [
  {
    method: 'GET',
    path: '/liquidity/token/{tokenA}/{tokenB}',
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
  const data = await getHeightedTokenPairLiquidity(
    context.tickLiquidityCache,
    params['tokenA'],
    params['tokenB'],
    query
  );
  if (data) {
    const [height, tickStateA] = data;
    return [height, tickStateA];
  }
  return null;
};

const getPaginatedResponse: GetEndpointResponse<DataSets, Shape> = (
  data,
  query
) => {
  const [, tickStateA = []] = data || [];
  // paginate the data
  const [page, pagination] = paginateData(
    tickStateA,
    query, // the time extents and frequency and such
    defaultPaginationLimit
  );
  return {
    data: page,
    pagination: pagination,
  };
};
