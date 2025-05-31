import sql, { raw } from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  getFillableTimePeriod,
  hours,
  inMs,
  minutes,
  WithFillTimePeriod,
  toUnixTime,
} from '../../utils/units';
import dexSwapVolumeTimeseries from '../../common-table-expressions/dexVolumeTimeseries';
import {
  selectVaultConfigs,
  VaultResponse,
} from '../../common-table-expressions/vaultConfigs';

export interface Request {
  params: { contract: string };
  query: {
    from?: string;
    to?: string;
    periods?: string;
    period?: WithFillTimePeriod;
    limit?: string;
  };
}
export interface Response {
  time: string;
  volume_0: number;
  volume_1: number;
  fees_0: number;
  fees_1: number;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/volume/:contract',
  handler: async (request, abortSignal, previousResponse) => {
    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
      `,
      abortSignal
    );

    // get timeseries data height (quick query to determine cache version)
    const contractResponse = await getCachedResponse<VaultResponse>(
      sql`
          SELECT *
          FROM (${selectVaultConfigs})
          WHERE "contract_address" = ${request.params.contract}
        `,
      abortSignal,
      {
        cacheTime: 1 * minutes * inMs,
      }
    );

    const data = contractResponse.data.at(0);
    if (!data) {
      throw new Error('NotFound', { cause: 404 });
    }
    const contract = data.contract_address;
    const token0 = {
      denom: data.token_0_denom,
      decimals: data.token_0_decimals,
      maxBlocksStale: data.token_0_max_blocks_stale,
      symbol: data.token_0_symbol,
      quoteCurrency: data.token_0_quote_currency,
    };
    const token1 = {
      denom: data.token_1_denom,
      decimals: data.token_1_decimals,
      maxBlocksStale: data.token_1_max_blocks_stale,
      symbol: data.token_1_symbol,
      quoteCurrency: data.token_1_quote_currency,
    };

    const denom0 = token0.denom;
    const denom1 = token1.denom;
    const pair0 = `${token0.symbol}-${token0.quoteCurrency}`;
    const pair1 = `${token1.symbol}-${token1.quoteCurrency}`;

    // get timeseries data height (quick query to determine cache version)
    const allUpdateHeights = await Promise.all([
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              max(t."height") AS "height",
              argMax("timestamp", t."height") as "time"
            FROM spacebox.dex_message_event_tick_state as t
            WHERE "TokenZero" = ${denom0}
              AND "TokenOne" = ${denom1}
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
      ),
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              max(t."height") AS "height",
              argMax("timestamp", t."height") as "time"
            FROM spacebox.bank_transfer_state as t
            WHERE "address" = ${request.params.contract}
              AND ("denom" = ${denom0} OR "denom" = ${denom1})
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
      ),
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        // todo: read directly from spacebox.slinky_pairs when timestamp information is available there
        sql`
            SELECT
              max(t."timestamp") as "time",
              argMax("height_to", t."timestamp") as "height"
            FROM spacebox.slinky_prices as t
            WHERE "id" IN (
              SELECT "id"
              FROM spacebox.slinky_pairs
              WHERE (
                "base" = ${token0.symbol} AND "quote" = ${token0.quoteCurrency}
                OR
                "base" = ${token1.symbol} AND "quote" = ${token1.quoteCurrency}
              )
            )
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
      ),
    ]);

    const currentHeight = allUpdateHeights
      .slice()
      .sort((a, b) => {
        const rowA = a.data.at(0);
        const rowB = b.data.at(0);
        return rowA && rowB
          ? Number(rowB.height) - Number(rowA.height)
          : rowA
          ? -1
          : 1;
      })
      .at(0);

    // get requested time period or default
    const timePeriods = Number(request.query.periods) || 1;
    const last24H = !getFillableTimePeriod(request.query.period);
    const timePeriod = getFillableTimePeriod(request.query.period) || 'minute';

    // get previous query limit
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // get contract start time
    const timeContractStart = toUnixTime(data.created_at);
    // ClickHouse will compare either native strings or Unix timestamps
    const unixFrom = Math.max(
      timeContractStart,
      Number(request.query.from) || 0
    );
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
        -- add fake columns to join the price data across
        -- without some specific ID rows ClickHouse will complain: "ASOF join needs at least one equi-join column"
        -- but we alread filter to the required IDs in the following CTEs
        ${pair0} as "quote_pair_zero",
        ${pair1} as "quote_pair_one",
        address_swap_volume AS (${dexSwapVolumeTimeseries(
          contract,
          denom0,
          denom1
        )}),
        -- get a standard period time of how much the vault has per time period
        amount_timeseries_of_period AS (
          SELECT
            ${
              last24H
                ? sql`toStartOfInterval(
                    addDays(NOW(), -1),
                    INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                  )`
                : sql`toStartOfInterval(t."timestamp", INTERVAL ${raw(
                    timePeriods.toFixed(0)
                  )} ${raw(timePeriod)})`
            } AS "timestamp",
            max(t."height") AS "height",
            -- now that we will split the value fields to two sides:
            -- bring in the contract value sides
            "quote_pair_zero" as "PairZero",
            "quote_pair_one" as "PairOne",
            -- values
            sumIf("volume_zero", "active" = 1) as "ActiveVolumeZero",
            sumIf("volume_one", "active" = 1) as "ActiveVolumeOne",
            sumIf("volume_zero", "active" = 0) as "PassiveVolumeZero",
            sumIf("volume_one", "active" = 0) as "PassiveVolumeOne",
            sum("fees_zero") as "FeesZero",
            sum("fees_one") as "FeesOne"
          FROM address_swap_volume as t
          WHERE 1 = 1
          ${
            last24H || unixFrom || timePrevious
              ? sql`AND t."timestamp" >= toStartOfInterval(
                  ${
                    last24H
                      ? sql`addDays(NOW(), -1)`
                      : sql`toDateTime(${unixFrom || timePrevious})`
                  },
                  INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                )`
              : raw('')
          }
          ${
            last24H || unixTo
              ? sql`AND t."timestamp" < toStartOfInterval(
                  ${last24H ? sql`NOW()` : sql`toDateTime(${unixTo})`},
                  INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                )`
              : raw('')
          }
          -- order by time
          GROUP BY "PairZero", "PairOne", "timestamp"
          ORDER BY "PairZero", "PairOne", "timestamp" ASC
        ),
        -- pre-aggregate specific pair prices to output time periods
        -- note: this dramatically reduces the ASOF join times
        grouped_prices AS (
          SELECT
            "pair_id",
            toStartOfInterval(t."timestamp", INTERVAL ${raw(
              timePeriods.toFixed(0)
            )} ${raw(timePeriod)}) AS "timestamp",
            argMax("price", t."timestamp") AS "price",
            argMax("decimals", t."timestamp") AS "decimals"
          FROM spacebox.raw_slinky_prices as t
          -- filter to symbol and contract start time
          WHERE ("pair_id" = "quote_pair_zero" OR "pair_id" = "quote_pair_one")
          ${
            last24H || unixFrom || timePrevious
              ? sql`AND t."timestamp" >= toStartOfInterval(
                  -- todo: fix with height_to >= heightAtTime(time) - 1 logic
                  -- add some breathing room (10 minutes) to get previous prices
                  addMinutes(${
                    last24H
                      ? sql`addDays(NOW(), -1)`
                      : sql`toDateTime(${unixFrom || timePrevious})`
                  }, -10),
                  INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                )`
              : raw('')
          }
          ${
            last24H || unixTo
              ? sql`AND t."timestamp" < toStartOfInterval(
                  ${last24H ? sql`NOW()` : sql`toDateTime(${unixTo})`},
                  INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                )`
              : raw('')
          }
          GROUP BY "pair_id", "timestamp"
          ORDER BY "timestamp" ASC
        ),
        swap_volume_amount_timeseries AS (
          SELECT
            amounts."timestamp" as "timestamp",
            amounts."height" as "height",
            toFloat64(amounts."ActiveVolumeZero") as "active_volume_zero",
            toFloat64(amounts."ActiveVolumeOne") as "active_volume_one",
            toFloat64(amounts."PassiveVolumeZero") as "passive_volume_zero",
            toFloat64(amounts."PassiveVolumeOne") as "passive_volume_one",
            amounts."FeesZero" as "FeesZero",
            amounts."FeesOne" as "FeesOne",
            "active_volume_zero" * toFloat64(p0."price") * exp10(-(p0."decimals" + ${
              token0.decimals
            })) as "active_volume_0",
            "active_volume_one" * toFloat64(p1."price") * exp10(-(p1."decimals" + ${
              token1.decimals
            })) as "active_volume_1",
            "passive_volume_zero" * toFloat64(p0."price") * exp10(-(p0."decimals" + ${
              token0.decimals
            })) as "passive_volume_0",
            "passive_volume_one" * toFloat64(p1."price") * exp10(-(p1."decimals" + ${
              token1.decimals
            })) as "passive_volume_1",
            "FeesZero" * toFloat64(p0."price") * exp10(-(p0."decimals" + ${
              token0.decimals
            })) as "fees_0",
            "FeesOne" * toFloat64(p1."price") * exp10(-(p1."decimals" + ${
              token1.decimals
            })) as "fees_1"
          FROM amount_timeseries_of_period as amounts
          -- join to closest available price or token zero
          -- todo: can improve accuracy by joining on exact event prices
          ASOF LEFT JOIN grouped_prices as p0
            ON (
              amounts."ActiveVolumeZero" > 0 OR
              amounts."PassiveVolumeZero" > 0
            )
            AND p0."pair_id" = amounts."PairZero"
            AND p0."timestamp" <= amounts."timestamp"
          -- join to closest available price or token one
          ASOF LEFT JOIN grouped_prices as p1
          ON (
              amounts."ActiveVolumeOne" > 0 OR
              amounts."PassiveVolumeOne" > 0
            )
            AND p1."pair_id" = amounts."PairOne"
            AND p1."timestamp" <= amounts."timestamp"
        )
        -- return renamed fields of rows where liquidity value exists
        SELECT
          "timestamp" as "time",
          "height",
          "passive_volume_0" as "volume_0_maker",
          "active_volume_0" as "volume_0_taker",
          "passive_volume_1" as "volume_1_maker",
          "active_volume_1" as "volume_1_taker",
          "fees_0" as "fees_0_maker",
          0 as "fees_0_taker",
          "fees_1" as "fees_1_maker",
          0 as "fees_1_taker"
        FROM swap_volume_amount_timeseries
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        getRow: ({ height, ...row }) => row,
        getHeight: (data) =>
          Number(data.find((row) => Number(row.height) > 0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add units (all USD except for time)
              // add time units, convert tick index units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : { ...row, units: 'USD' }
              )
          );
        },
        // flag as complete if there will be no data changes after this
        isComplete:
          !!unixTo && toUnixTime(currentHeight?.data.at(0)?.time) > unixTo,
        cacheTime: 1 * hours * inMs,
        // force hour cache for these results for now
        cacheVersion: 0,
      }
    );
  },
};
