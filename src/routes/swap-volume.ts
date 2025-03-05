import { Request, ResponseToolkit } from '@hapi/hapi';
import logger from '../utils/logger';

import { getCachedResponse } from '../utils/cache-query';
import { hours, inMs, seconds } from '../utils/time';
import sql from '../utils/sql';
import { raw } from 'sql-template-tag';

// define known USDC denoms for easy approximate USD price response
const denomsUSDC = {
  noble: 'ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81',
  axl: 'ibc/F082B65C88E4B6D5EF1DB243CDA1D331D002759E938A0F5CD3FFDC5D53B3E349',
};

const periods = ['day', 'hour', 'minute', 'seconds'] as const;
const LIMIT_ROWS = 1000;
export const route = {
  method: 'GET',
  path: '/swap-volume/{denomA}/{denomB}',
  handler: async (
    request: Request<{
      Params: { denomA: string; denomB: string };
      Query: { from?: number; to?: number; period?: (typeof periods)[number] };
    }>,
    h: ResponseToolkit
  ) => {
    try {
      const [denom0, denom1] = [
        request.params.denomA,
        request.params.denomB,
      ].sort();
      const denomReporting =
        Array.from(Object.values(denomsUSDC)).find((denom) => {
          return [denom0, denom1].includes(denom);
        }) || request.params.denomA;

      // default to bounds far in the future and in the past
      const unixFrom = Number(request.query.from) || 0;
      const unixTo = Number(request.query.to) || 0;

      // get timeseries query
      if (request.query.period && periods.includes(request.query.period)) {
        const currentHeight =
          unixTo === 0 || unixTo * 1000 >= Date.now()
            ? // for a "now-bound" request use the slightly-cached relevant data height
              await getCachedResponse<{ height: string }>(
                sql`
                  SELECT max("height") AS "height"
                  FROM spacebox."dex_message_event_tick_update"
                  WHERE "TokenZero" = ${denom0}
                    AND "TokenOne" = ${denom1}
                    AND "is_swap" = 1
                `,
                {
                  cacheTime: 0.1 * seconds * inMs,
                }
              )
            : undefined;

        return await getCachedResponse<{
          time: string;
          volume: string;
          denom: string;
        }>(
          sql`
            SELECT
              toStartOfInterval("timestamp", INTERVAL 1 ${raw(
                `${request.query.period}`
              )}) AS "time",
              sumIf("SwapAmountIn", "TokenIn" != ${denomReporting}) +
              sumIf("SwapAmountOut", "TokenIn" = ${denomReporting}) as "volume",
              ${denomReporting} as "denom"
            FROM (${selectDexTickUpdates})
            WHERE "is_swap" = 1
              AND "timestamp" >= ${unixFrom}
              AND "timestamp" < ${unixTo || raw('NOW()')}
              AND "TokenZero" = ${denom0}
              AND "TokenOne" = ${denom1}
            GROUP BY "time"
            ORDER BY "time" DESC
            LIMIT ${LIMIT_ROWS}
          `,
          {
            cacheTime: 1 * hours * inMs,
            cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
          }
        );
      }

      // get 24 hour volume cached to "beginning of the hour" version
      return await getCachedResponse<{ volume: string; denom: string }>(
        sql`
        SELECT
          sumIf("SwapAmountIn", "TokenIn" != ${denomReporting}) +
          sumIf("SwapAmountOut", "TokenIn" = ${denomReporting}) as "volume",
          ${denomReporting} as "denom"
        FROM (${selectDexTickUpdates})
        WHERE "is_swap" = 1
          AND "timestamp" >= toStartOfHour(addDays(NOW(), -1))
          AND "timestamp" < toStartOfHour(NOW())
          AND "TokenZero" = ${denom0}
          AND "TokenOne" = ${denom1}
      `,
        {
          cacheTime: 1 * hours * inMs,
          cacheVersion: Math.floor(Date.now() / (1 * hours * inMs)),
        }
      );
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

// this select statement applies the "swap volume fix" to recreate
// SwapAmountIn/SwapAmountOut for events in Neutron <= v5 that do not have them
const selectDexTickUpdates = sql`
  -- get indexed updates in order with an update_index field
  -- to help determine the ReservesDiff field: the current - previous Reserves value
  WITH "dex_tick_update_events_indexed" AS (
    SELECT
      *,
      ROW_NUMBER() OVER (
        -- partition by "pools" of reserves (they are separate per tick + fee/tranche combination)
        -- "partition by" pool index (tick_index+fee or tick_index+tranche_key for each pair side)
        PARTITION BY "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee", "TrancheKey"
        -- within the pool index partition, sort by event order
        ORDER BY "height" ASC, "block_part_index" ASC, "tx_index" ASC, "event_index" ASC
      ) AS "update_index"
    FROM spacebox."dex_message_event_tick_update"
  )
  -- combine ordered updates to get relative state (ReservesDiff) and
  -- use the already derived is_swap field to compute new SwapAmountIn and SwapAmountOut attributes
  SELECT
    "current_state".*,
    -- get difference from last Reserves value
    ("current_state"."Reserves" - "previous_state"."Reserves") as "ReservesDiff",
    -- note: all swap TickUpdate events should be DEX decrements (ReservesDiff < 0)
    if (
      "is_swap" AND "ReservesDiff" < 0,
      toUInt128(abs("ReservesDiff")),
      "current_state"."SwapAmountOut"
    ) as "SwapAmountOut",
    -- note: SwapAmountIn may have rounding errors (but this very small in practice)
    if (
      "is_swap" AND "ReservesDiff" < 0,
      toUInt128(ceiling(multiply(toFloat64(abs("ReservesDiff")), pow(1.0001, "TickIndex")))),
      "current_state"."SwapAmountIn"
    ) as "SwapAmountIn"
  FROM "dex_tick_update_events_indexed" as "current_state"
  -- join on same tick pool, but on the previous update
  LEFT JOIN "dex_tick_update_events_indexed" as "previous_state" ON (
    "current_state"."TokenZero" = "previous_state"."TokenZero" AND
    "current_state"."TokenOne" = "previous_state"."TokenOne" AND
    "current_state"."TokenIn" = "previous_state"."TokenIn" AND
    "current_state"."TickIndex" = "previous_state"."TickIndex" AND
    "current_state"."Fee" = "previous_state"."Fee" AND
    "current_state"."TrancheKey" = "previous_state"."TrancheKey" AND
    "current_state"."update_index" = "previous_state"."update_index" + 1
  )
`;
