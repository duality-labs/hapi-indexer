import { Request, ResponseToolkit } from '@hapi/hapi';
import logger from './logger';

// add debug route
const debugRoute = {
  method: 'GET',
  path: '/debug/{limit?}',
  handler: async (request: Request, h: ResponseToolkit) => {
    // set limit to all or the given number (defaulting to 100)
    const limit = Number(request.params['limit']) || 100;
    try {
      return { limit };
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
