import { Request, ResponseToolkit } from '@hapi/hapi';

import {
  DataRow,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairLiquidity';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';

import { selectRequestMechanism } from '../../mechanisms/_select';
import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';

const shape = [
  [['tick_index', 'reserves']],
  [['tick_index', 'reserves']],
] as const;
type Shape = typeof shape;
type DataSets = [Array<DataRow>, Array<DataRow>];

const defaultPaginationLimit = 10000;

const routes = [
  {
    method: 'GET',
    path: '/liquidity/pair/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      const requestMechanism = selectRequestMechanism<DataSets, Shape>(request);
      return requestMechanism(request, h, getData, getResponse, shape);
    },
  },
];

export default routes;

const getData: GetEndpointData<DataSets> = async (server, params, query) => {
  const blockRange = getBlockRange(query);
  const { from_height: fromHeight = 0, to_height: toHeight } = blockRange;
  return getHeightedTokenPairLiquidity(
    server,
    params['tokenA'],
    params['tokenB'],
    { fromHeight, toHeight }
  );
};

const getResponse: GetEndpointResponse<DataSets, Shape> = (
  data,
  query,
  { paginate, defaults }
) => {
  const [, tickStateA = [], tickStateB = []] = data || [];
  if (paginate) {
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
      shape: defaults.shape,
      data: [pageA, pageB],
      pagination: {
        // the next key will be the same if it exists on both sides
        next_key: paginationA.next_key ?? paginationB.next_key,
        total:
          paginationA.total !== undefined && paginationB.total !== undefined
            ? paginationA.total + paginationB.total
            : undefined,
      },
      block_range: defaults.block_range,
    };
  } else {
    // or use unpaginated data
    return {
      shape: defaults.shape,
      data: [tickStateA, tickStateB],
      block_range: defaults.block_range,
    };
  }
};
