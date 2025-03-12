// router.d.ts
// Type definitions for router
// modified from: https://github.com/pillarjs/router/issues/48#issuecomment-881248412

declare module 'router' {
  import { NextFunction, NextHandleFunction } from 'connect';
  import { IncomingMessage, ServerResponse } from 'http';

  export type ExtendedRequest<
    Params extends Record<string, string> | undefined = Record<string, string>,
    Query extends Record<string, string> | undefined = Record<string, string>
  > = IncomingMessage & { params: Params; query: Query };
  export type FinalHandleFunction<
    Params extends Record<string, string>,
    Query extends Record<string, string>
  > = (
    req: ExtendedRequest<Params, Query>,
    res: ServerResponse,
    next: (err?: Error) => void
  ) => void;

  export type HTTP2NextHandleFunction = (
    req: Omit<IncomingMessage, 'headersDistinct' | 'trailersDistinct'>,
    res: ServerResponse,
    next: (err?: Error) => void
  ) => void;

  export type Path = string | RegExp | Array<string | RegExp>;

  export namespace Router {
    export interface RouteType {
      new (path: string): Route;
      prototype: Route;
    }

    type Method =
      | 'all'
      | 'head'
      | 'get'
      | 'post'
      | 'delete'
      | 'put'
      | 'patch'
      | 'options';

    export type Route<
      Params extends Record<string, string> = Record<string, string>,
      Query extends Record<string, string> = Record<string, string>
    > = { readonly path: Path } & Record<
      Method,
      (
        middleware: FinalHandleFunction<Params, Query>,
        ...middlewares: FinalHandleFunction<Params, Query>[]
      ) => Route
    >;

    export interface Options {
      caseSensitive?: boolean;
      strict?: boolean;
      mergeParams?: <
        C extends Record<string, never>,
        P extends Record<string, never>
      >(
        currentParams: C,
        parentParams: P
      ) => Record<string | number, unknown>;
    }

    export type ParamCallback<K = string | number> = (
      req: Omit<IncomingMessage, 'headersDistinct' | 'trailersDistinct'>,
      res: ServerResponse,
      next: NextFunction,
      value: unknown,
      name: K
    ) => unknown;

    interface InnerRouter extends HTTP2NextHandleFunction {
      route(path: Path): Route;
      param: <K extends string | number>(name: K, fn: ParamCallback<K>) => this;
    }

    export type Router = InnerRouter &
      Record<
        'use' | Method,
        {
          (
            path: Path,
            middleware: NextHandleFunction,
            ...middlewares: NextHandleFunction[]
          ): Router;
          (
            middleware: NextHandleFunction,
            ...middlewares: NextHandleFunction[]
          ): Router;
        }
      >;

    interface RouterType {
      new (options?: Options): Router;
      (options?: Options): Router;
      Route: RouteType;
      prototype: Router;
    }
  }

  export type RouterType = Router.RouterType;
  const Router: RouterType;
  export default Router;
}
