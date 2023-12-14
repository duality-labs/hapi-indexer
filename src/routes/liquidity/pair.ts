import { Request, ResponseToolkit, ServerRoute } from '@hapi/hapi';

import {
  DataRowA,
  DataRowB,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairLiquidity';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';

import processRequest from '../../mechanisms';
import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';
import { Plugins } from '.';

const shape = [
  [['tick_index_b_to_a', 'reserves']],
  [['tick_index_a_to_b', 'reserves']],
] as const;
type Shape = typeof shape;
type DataSets = [Array<DataRowA>, Array<DataRowB>];

const defaultPaginationLimit = 10000;

const routes: ServerRoute[] = [
  {
    method: 'GET',
    path: '/liquidity/pair/{tokenA}/{tokenB}',
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
  return await getHeightedTokenPairLiquidity(
    context.tickLiquidityCache,
    params['tokenA'],
    params['tokenB'],
    query
  );
};

export const getPaginatedResponse: GetEndpointResponse<DataSets, Shape> = (
  data,
  query
) => {
  const [, tickStateA = [], tickStateB = []] = data || [];
  // paginate the data
  const [pageA, paginationA] = paginateData(
    tickStateA,
    query, // the time extents and frequency and such
    defaultPaginationLimit
  );
  const [pageB, paginationB] = paginateData(
    tickStateB,
    query, // the time extents and frequency and such
    defaultPaginationLimit
  );
  return {
    data: [pageA, pageB],
    pagination: {
      // the next key will be the same if it exists on both sides
      next_key: paginationA.next_key ?? paginationB.next_key,
      // total should make sense that: total = lastOffset + lastPage.length
      // which for an endpoint returning multiple lists is the longest list
      total:
        paginationA.total !== undefined && paginationB.total !== undefined
          ? Math.max(paginationA.total, paginationB.total)
          : undefined,
      totals:
        paginationA.total !== undefined && paginationB.total !== undefined
          ? [paginationA.total, paginationB.total]
          : undefined,
    },
  };
};
