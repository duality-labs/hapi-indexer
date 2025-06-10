import { Route } from '../../types';
import {
  route as userPnlRoute,
  Request as UserPnlRequest,
  Response as UserPnlResponse,
} from './user/pnl';

export interface Request {
  params: { contract: string };
  query: UserPnlRequest['query'];
}
export type Response = UserPnlResponse;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/:contract/pnl',
  handler: async (request, abortSignal, previousResponse) => {
    // use falsy wallet address to mean no specific address
    return userPnlRoute.handler(
      {
        params: { contract: request.params.contract, address: '' },
        query: request.query,
      },
      abortSignal,
      previousResponse
    );
  },
};
