import {
  Plugin,
  Request,
  ResponseToolkit,
  ServerRegisterOptions,
} from '@hapi/hapi';
import logger from '../logger';
import { client } from '../client';
import { Policy, PolicyOptions } from '@hapi/catbox';

import { ResponseJSON } from '@clickhouse/client';

type QueryResult = ResponseJSON<unknown>;
type QueryCache = Policy<QueryResult, PolicyOptions<QueryResult>>;

const name = 'swapVolumeCache';
const swapVolumeCache: PolicyOptions<QueryResult> = {
  expiresIn: 1000 * 60 * 10, // 10 minutes
  generateFunc: async (id) => {
    const { denom0, denom1 } = JSON.parse(`${id}`);
    const response = await client.query({
      query: `--sql
        -- get indexed updates in order with an update_index field
        -- to help determine the ReservesDiff field: the current - previous Reserves value
        WITH dex_tick_update_events_indexed AS (
            SELECT
                *,
                ROW_NUMBER() OVER (
                    -- partition by "pools" of reserves (they are separate per tick + fee/tranche combination)
                    -- "partition by" pool index (tick_index+fee or tick_index+tranche_key for each pair side)
                    PARTITION BY TokenZero, TokenOne, TokenIn, TickIndex, Fee, TrancheKey
                    -- within the pool index partition, sort by event order
                    ORDER BY height ASC, block_part_index ASC, tx_index ASC, event_index ASC
                ) AS update_index
            FROM test.dex_message_event_tick_update
        ),
        -- combine ordered updates to get relative state (ReservesDiff) and
        -- use the already derived is_swap field to compute new SwapAmountIn and SwapAmountOut attributes
        dex_tick_update_events_extended AS (
            SELECT
                current_state.*,
                -- get difference from last Reserves value
                (current_state.Reserves - previous_state.Reserves) as ReservesDiff,
                -- note: all swap TickUpdate events should be DEX decrements (ReservesDiff < 0)
                if(is_swap AND ReservesDiff < 0, toUInt128(abs(ReservesDiff)), 0) as SwapAmountOut,
                -- note: SwapAmountIn may have rounding errors (but this very small in practice)
                if(is_swap AND ReservesDiff < 0, toUInt128(ceiling(multiply(toFloat64(abs(ReservesDiff)), pow(1.0001, TickIndex)))), 0) as SwapAmountIn
            FROM dex_tick_update_events_indexed as current_state
            -- join on same tick pool, but on the previous update
            LEFT JOIN dex_tick_update_events_indexed as previous_state ON (
                current_state.TokenZero = previous_state.TokenZero AND
                current_state.TokenOne = previous_state.TokenOne AND
                current_state.TokenIn = previous_state.TokenIn AND
                current_state.TickIndex = previous_state.TickIndex AND
                current_state.Fee = previous_state.Fee AND
                current_state.TrancheKey = previous_state.TrancheKey AND
                current_state.update_index = previous_state.update_index + 1
            )
        )
        -- example selection of USDC swap volume of NTRN<>USDC pair over the lifetime of the DEX
        SELECT
            sumIf(SwapAmountIn, TokenIn != 'ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81') +
            sumIf(SwapAmountOut, TokenIn = 'ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81') as TotalSwapVolumeUSDC
        FROM dex_tick_update_events_extended
        WHERE timestamp >= toStartOfInterval(addDays(NOW(), -1), INTERVAL 1 HOUR)
          AND timestamp < toStartOfInterval(NOW(), INTERVAL 1 HOUR)
          AND TokenZero = '${denom0}'
          AND TokenOne = '${denom1}'
      `,
    });
    return await response.json();
  },
  generateTimeout: 1000 * 20,
};

interface Plugins {
  swapVolumeCache: QueryCache;
}

export const plugin: Plugin<ServerRegisterOptions> = {
  name,
  register: async function (server) {
    const pluginContext: Plugins = {
      // add liquidity specific caches
      swapVolumeCache: server.cache({
        segment: name,
        ...swapVolumeCache,
      }),
    };
    server.bind(pluginContext);
    server.route([route]);
  },
};

// add debug route
const route = {
  method: 'GET',
  path: '/swap-volume/{denomA}/{denomB}/{timePeriod?}',
  handler: async (request: Request, h: ResponseToolkit) => {
    try {
      const [denom0, denom1] = [
        request.params.denomA,
        request.params.denomB,
      ].sort();
      const result = await (h.context as Plugins).swapVolumeCache.get(
        JSON.stringify({
          denom0,
          denom1,
          timePeriod: request.params.timePeriod,
        })
      );
      return result?.data;
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
