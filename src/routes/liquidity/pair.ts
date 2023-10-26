import { Request, ResponseToolkit } from '@hapi/hapi';

import {
  DataRow,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairLiquidity';
import { paginateData } from '../../storage/sqlite3/db/paginationUtils';
import { getBlockRange } from '../../storage/sqlite3/db/blockRangeUtils';

import longPollRequest from '../../mechanisms/long-polling';
import sseRequest from '../../mechanisms/server-sent-events';
import { GetEndpointData, GetEndpointResponse } from '../../mechanisms/types';

const dataShape = [
  ['tick_index', 'reserves'],
  ['tick_index', 'reserves'],
] as const;
type Shape = typeof dataShape;
type DataSets = [Array<DataRow>, Array<DataRow>];

const defaultPaginationLimit = 10000;

const routes = [
  {
    method: 'GET',
    path: '/liquidity/pair/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      const canUseSSE =
        request.query['stream'] === 'true' &&
        request.raw.req.httpVersionMajor === 2;
      return canUseSSE
        ? sseRequest<DataSets, Shape>(request, h, getData, getResponse)
        : longPollRequest<DataSets, Shape>(request, h, getData, getResponse);
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
  { paginate, shape }
) => {
  const [height, tickStateA = [], tickStateB = []] = data || [];
  return {
    ...(shape && { shape: dataShape }),
    ...(paginate
      ? // use unpaginated data
        (() => {
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
              total:
                paginationA.total !== undefined &&
                paginationB.total !== undefined
                  ? paginationA.total + paginationB.total
                  : undefined,
            },
          };
        })()
      : // or use unpaginated data
        { data: [tickStateA, tickStateB] }),
    // indicate what range the data response covers
    block_range: {
      from_height: getBlockRange(query).from_height || 0,
      to_height: height,
    },
  };
};
