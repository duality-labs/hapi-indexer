import logger from '../utils/logger';
import { client } from '../utils/client';
import { ExtendedRequest } from 'router';
import { ServerResponse } from 'node:http';

// add debug route
export const debugQuery = {
  method: 'GET',
  path: '/debug/query',
  handler: async (
    req: ExtendedRequest<
      undefined,
      { query?: string; username?: string; password?: string }
    >,
    res: ServerResponse,
    next: (err?: Error) => void
  ) => {
    try {
      const query = req.query['query'];
      if (!query) {
        throw new Error('No query');
      }
      const response = await client.query({
        query,
        ...(req.query['username'] &&
          req.query['password'] && {
            auth: {
              username: req.query['username'],
              password: req.query['password'],
            },
          }),
      });
      res.setHeader('content-type', 'application/json');
      res.end(response.text());
      next();
    } catch (err: unknown) {
      logger.error(err);
      res.statusCode = 500;
      res.end('An unknown error occurred');
      next(new Error('An unknown error occurred', { cause: err }));
    }
  },
};

// add debug route
export const debugHeight = {
  method: 'GET',
  path: '/debug/height',
  handler: async (
    req: ExtendedRequest<
      undefined,
      { query?: string; username?: string; password?: string }
    >,
    res: ServerResponse,
    next: (err?: Error) => void
  ) => {
    req.query.query =
      'SELECT max(height) as raw_block_results_height from raw_block_results';
    return debugQuery.handler(req, res, next);
  },
};
