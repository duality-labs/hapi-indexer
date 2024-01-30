import { Request, ResponseObject, ResponseToolkit } from '@hapi/hapi';

import logger from '../logger';
import { getLastBlockHeight, waitForNextBlock } from '../sync';
import {
  getMsLeft,
  inMs,
  minutes,
} from '../storage/sqlite3/db/timeseriesUtils';
import { getBlockRange } from '../storage/sqlite3/db/blockRangeUtils';

import {
  EndpointResponse,
  GetEndpointData,
  GetEndpointResponse,
  ServerPluginContext,
} from './types';

const timeoutMs = 3 * minutes * inMs;

export default async function longPollRequest<
  PluginContext,
  DataSets extends unknown[],
  Shape
>(
  request: Request,
  h: ResponseToolkit,
  {
    shape,
    getData,
    getPaginatedResponse,
    compressResponses,
  }: {
    shape: Shape;
    getData: GetEndpointData<PluginContext, DataSets>;
    getPaginatedResponse: GetEndpointResponse<DataSets, Shape>;
    compressResponses?: boolean;
  }
): Promise<ResponseObject> {
  try {
    const lastBlockHeight = getLastBlockHeight();
    const blockRange = await getBlockRange(request.query);

    // get the data now or at next block height that contains data
    let data: [height: number, ...DataSets] | null = null;
    // get the data now or at next block height that contains data
    if (blockRange.from_height < lastBlockHeight) {
      data = await getData(request.params, request.query, h.context);
    }
    if (blockRange.from_height > lastBlockHeight) {
      return h.response('Cannot wait for future start height').code(400);
    }
    // await new data if the height was specified but no data was yet found
    else if (blockRange.from_height && !data) {
      const timeLeft = getMsLeft(timeoutMs);
      // wait until we get new non-empty data
      while (((data || []) as [][]).every((v) => !v?.length)) {
        // wait for next block
        try {
          await waitForNextBlock(timeLeft());
        } catch {
          // but throw timeout if waited for too long
          return h.response('Request Timeout').code(408);
        }
        // get current data
        data = await getData(request.params, request.query, h.context);
      }
    }

    // return errors if needed
    if (!data) {
      return h.response('Not Found').code(404);
    }

    const [height] = data;
    const partialResponse = getPaginatedResponse(data, request.query);
    // construct response in correct order with applied defaults
    const response: EndpointResponse<DataSets, Shape> = {
      shape: partialResponse?.shape ?? shape,
      data: partialResponse?.data,
      pagination: partialResponse?.pagination,
      block_range: partialResponse?.block_range ?? {
        from_height: blockRange.from_height,
        to_height: height,
      },
    };
    return h
      .response(
        request.generateResponse(response, {
          marshal: compressResponses
            ? (
                request.server.plugins as ServerPluginContext
              ).compressResponse?.withKey(request.url.toJSON())
            : undefined,
        })
      )
      .code(200);
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.error(err);
      return h
        .response(err.message || 'An unknown error occurred')
        .code(Number(err.cause) || 500);
    }
    return h.response('An unknown error occurred').code(500);
  }
}
