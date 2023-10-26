import { Request, ResponseToolkit } from '@hapi/hapi';

import {
  DataRow,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairLiquidity';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';
import { selectRequestMechanism } from '../../mechanisms/_select';
import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';

const shape = [['tick_index', 'reserves']] as const;
type Shape = typeof shape;
type DataSets = [Array<DataRow>];

const defaultPaginationLimit = 10000;

const routes = [
  {
    method: 'GET',
    path: '/liquidity/token/{tokenA}/{tokenB}',
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
  const data = await getHeightedTokenPairLiquidity(
    server,
    params['tokenA'],
    params['tokenB'],
    {
      fromHeight,
      toHeight,
    }
  );
  if (data) {
    const [height, tickStateA] = data;
    return [height, tickStateA];
  }
  return null;
};

const getResponse: GetEndpointResponse<DataSets, Shape> = (
  data,
  query,
  { paginate, defaults }
) => {
  const [, tickStateA = []] = data || [];
  if (paginate) {
    // paginate the data
    const [page, pagination] = paginateData(
      tickStateA,
      query, // the time extents and frequency and such
      defaultPaginationLimit
    );
    return {
      shape: defaults.shape,
      data: page,
      pagination: pagination,
      block_range: defaults.block_range,
    };
  } else {
    // or use unpaginated data
    return {
      shape: defaults.shape,
      data: tickStateA,
      block_range: defaults.block_range,
    };
  }
};
