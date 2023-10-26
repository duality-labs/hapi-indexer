import { Request, ResponseToolkit } from '@hapi/hapi';

import {
  DataRow,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairLiquidity';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';
import { getBlockRange } from '../../storage/sqlite3/db/blockRangeUtils';
import { selectRequestMechanism } from '../../mechanisms/_select';
import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';

const dataShape = [['tick_index', 'reserves']] as const;
type Shape = typeof dataShape;
type DataSets = [Array<DataRow>];

const defaultPaginationLimit = 10000;

const routes = [
  {
    method: 'GET',
    path: '/liquidity/token/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      const requestMechanism = selectRequestMechanism<DataSets, Shape>(request);
      return requestMechanism(request, h, getData, getResponse);
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
  { paginate, shape }
) => {
  const [height, tickStateA = []] = data || [];
  return {
    ...(shape && { shape: dataShape }),
    ...(paginate
      ? // use unpaginated data
        (() => {
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
        })()
      : // or use unpaginated data
        { data: tickStateA }),
    // indicate what range the data response covers
    block_range: {
      from_height: getBlockRange(query).from_height || 0,
      to_height: height,
    },
  };
};
