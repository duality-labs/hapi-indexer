import { Request, ResponseToolkit } from '@hapi/hapi';
import logger from './logger';
import { client } from './client';

// add debug route
const debugRoute = {
  method: 'GET',
  path: '/debug',
  handler: async (request: Request, h: ResponseToolkit) => {
    try {
      const query = request.query['query'];
      const response = await client.query({ query });
      return await response.json();
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
};

export const routes = [
  // add development only paths
  ...(process.env.NODE_ENV === 'development' ? [debugRoute] : []),
];
