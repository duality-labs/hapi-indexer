import { Route } from '../../../types';
import {
  route as userPnlRoute,
  Request as UserPnlRequest,
  Response as UserPnlResponse,
} from '../user/pnl';

export interface Request {
  params: { address: string; contract: string };
  query: UserPnlRequest['query'];
}
export type Response = UserPnlResponse;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/:contract/user/:address/tvl',
  handler: async (request, abortSignal, previousResponse) => {
    // use falsy wallet address to mean no specific address
    return userPnlRoute.handler(
      {
        params: request.params,
        query: request.query,
      },
      abortSignal,
      previousResponse
    );
  },
};
