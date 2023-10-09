import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import {
  TickLiquidityResponse,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTickLiquidity';
import {
  decodePagination,
  paginateData,
} from '../../storage/sqlite3/db/paginationUtils';
import { newHeightEmitter } from '../../sync';

function getEtagRequestHeader(
  headers: Request['headers'],
  header: 'If-Match' | 'If-None-Match'
): string | undefined {
  // get header as string
  const headerString = headers[header] || headers[header.toLowerCase()];
  // note: eTags should come enclosed in double quotes, this is due to an
  //       RFC spec to distnguish weak vs. strong entity tags
  // link: https://www.rfc-editor.org/rfc/rfc7232#section-2.3
  // get header as un-double-quoted string
  return `${headerString}`.replace(/^"(.+)"$/, '$1') || undefined;
}

function getHeightRequest(
  headers: Request['headers'],
  header: 'If-Match' | 'If-None-Match'
): number | undefined {
  const eTag = getEtagRequestHeader(headers, header);
  return (eTag && Number(eTag.split('-').at(0))) || undefined;
}

const routes = [
  {
    method: 'GET',
    path: '/liquidity/token/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const pollHeight = getHeightRequest(request.headers, 'If-None-Match');

        if (pollHeight) {
          let currentData = await getHeightedTokenPairLiquidity(
            request.server,
            request.params['tokenA'],
            request.params['tokenB']
          );
          while ((currentData?.[0] || 0) <= pollHeight) {
            // wait for next block
            await new Promise((resolve) => {
              newHeightEmitter.once('newHeight', resolve);
            });
            // get current data
            currentData = await getHeightedTokenPairLiquidity(
              request.server,
              request.params['tokenA'],
              request.params['tokenB']
            );
          }
        }

        // get requested height from match header
        const requestedHeight = getHeightRequest(request.headers, 'If-Match');

        // get the liquidity data
        const data = await getHeightedTokenPairLiquidity(
          request.server,
          request.params['tokenA'],
          request.params['tokenB'],
          requestedHeight
        );

        // return errors if needed
        if (!data) {
          return h.response('Not Found').code(404);
        }

        const [height, tickStateA] = data;
        if (requestedHeight) {
          if (height > requestedHeight) {
            return h
              .response(
                `Token liquidity for height ${requestedHeight} data is no longer available`
              )
              .code(412);
          }
          if (height < requestedHeight) {
            return h
              .response(
                `Token liquidity for height ${requestedHeight} data is not yet available`
              )
              .code(412);
          }
        }

        // create tag from height and { offset, limit } pagination keys
        const { offset, limit } = decodePagination(request.query, 10000);
        const etag = [height, offset, limit].join('-');
        h.entity({ etag });

        // paginate the data
        const [page, pagination] = paginateData(
          tickStateA,
          request.query, // the time extents and frequency and such
          10000
        );
        const response: TickLiquidityResponse = {
          shape: ['tick_index', 'reserves'],
          data: page,
          pagination,
        };
        return response;
      } catch (err: unknown) {
        if (err instanceof Error) {
          logger.error(err);
          return h
            .response(`something happened: ${err.message || '?'}`)
            .code(500);
        }
        return h.response('An unknown error occurred').code(500);
      }
    },
  },
];

export default routes;
