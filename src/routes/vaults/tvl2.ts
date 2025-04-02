import sql, { raw } from 'sql-template-tag';

import { handleResponse } from '../../utils/response';
import { getCachedResponse } from '../../utils/cache-query';
import {
  getTimePeriod,
  hours,
  inMs,
  TimePeriod,
  toUnixTime,
} from '../../utils/units';

const LIMIT_ROWS = 10;

// vault TVL is the value of DenomA and DenomB tokens held by a vault contract
//   - vault denom amounts held on contract (eg. vault wallet balance)
//     - there are deb_and_creds so i can work out the amount at end of block
//   - vault denom amounts held by the contract on the DEX (eg. neutron/pool/* balances)
// the value of these tokens will change with time with the market even if the
// token amounts do not change
export const route = {
  method: 'GET',
  path: '/supervaults/tvl/:denomA/:denomB',
  handler: handleResponse<
    {
      Params: { denomA: string; denomB: string };
      Query: {
        from?: string;
        to?: string;
        periods?: string;
        period?: TimePeriod;
        limit?: string;
      };
    },
    { time: string }
  >(async (request, abortSignal, previousResponse) => {
    const limit = Number(request.query.limit) || LIMIT_ROWS;
    const [denom0, denom1] = [
      request.params.denomA,
      request.params.denomB,
    ].sort();

    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
      `,
      abortSignal
    );

    // get timeseries data height (quick query to determine cache version)
    const currentHeight = await getCachedResponse<{
      height: string;
      time: string;
    }>(
      sql`
        SELECT
          max(t."height") AS "height",
          argMax("timestamp", t."height") as "time"
        FROM spacebox."dex_message_event_tick_update" as t
        WHERE "TokenZero" = ${denom0}
          AND "TokenOne" = ${denom1}
      `,
      abortSignal
    );

    // get requested time period or default
    const timePeriods = Number(request.query.periods) || 1;
    const timePeriod = getTimePeriod(request.query.period as string) || 'day';
    // get previous query limit
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // get requested times or zero
    const unixFrom = Number(request.query.from) || 0;
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<
      {
        time: string;
        TokenIn: string;
        TickIndex: string;
        Fee: string;
        TrancheKey: string;
        Reserves: string;
        height: string;
      },
      {
        time: string;
        TokenIn: string;
        TickIndex: string;
        Fee: string;
        TrancheKey: string;
        Reserves: string;
      }
    >(
      sql`
        WITH
        -- lp_dex_balance_event_timeseries AS (
        --   -- WITH (
        --   --   ("event_index"        * toUInt256(1))
        --   --   + ("tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
        --   --   + ("block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
        --   --   + ("height"           * toUInt256(4722366482869645213696))
        --   -- ) as "version"
        --   SELECT
        --     -- max(height) OVER interval_window AS "last_height",
        --     "timestamp",
        --     "height", "block_part_index", "tx_index", "event_index",
        --     "action", -- TickUpdate
        --     -- pool index keys
        --     "TokenZero", "TokenOne",
        --     -- reserve information
        --     -- Reserves
        --     sum("ReservesZeroDeposited") OVER user_pair_window AS "ReservesZeroDeposited",
        --     sum("ReservesOneDeposited") OVER user_pair_window AS "ReservesOneDeposited",
        --     -- "grouped by user"
        --     "Receiver"
        --   FROM spacebox.dex_message_event_lp_user_balance
        --   -- todo: fix missing DepositLP from WASM events before height 19947000 issue
        --   WHERE height >= 19964191
        --     -- AND "Receiver" = 'neutron1jmpf37kfscaqe884nkmxa694nfnk4kt75gd4umf097uyvzz9ahlqnet797'
        --     AND "Receiver" = 'neutron1eqecswp0ajvlvf344k80c5w4c948zwg4lq3zgg6mdd20hcqef2mqd8rvca'
        --   WINDOW user_pair_window AS (
        --     PARTITION BY
        --       -- partition to each user's pair deposit balance
        --       "TokenZero", "TokenOne", "Receiver"
        --     -- order by ascending event position within interval time
        --     ORDER BY
        --       "height" ASC,
        --       "block_part_index" ASC,
        --       "tx_index" ASC,
        --       "event_index" ASC
        --     -- get all known values up to the row's point in time
        --     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        --   )
        -- ),
        lp_dex_balance_changes_of_all_pools AS (
          WITH cumulative_shares as (
            SELECT
              "timestamp",
              "height",
              "block_part_index",
              "tx_index",
              "event_index",
              -- pool index keys
              "TokenZero", "TokenOne",
              "TickIndexZero", "TickIndexOne", "Fee",
              -- reserve information
              -- Reserves
              sumIf("shares", "Receiver" = 'neutron1jmpf37kfscaqe884nkmxa694nfnk4kt75gd4umf097uyvzz9ahlqnet797') OVER cumulative_window AS "ContractShares",
              sum("shares") OVER cumulative_window AS "TotalShares",
              -- todo: replace these with TickUpdate reserves info
              -- HERE: we stack this table with a UNION ALL of a transformed TickUpdate table (or two for both sides) (try to use one for one table scan only)
              --   - each cumulative_shares row need to know the TickUpdate last_cumulative_value ( last_value() OVER (UNBOUNDED PRECEDING TO CURRENT ROW) )
              --     - for reserves side: last_value(TickUpdateReservesZero) ignores NULL by default
              --     - for reserves side: last_value(TickUpdateReservesOne) ignores NULL by default
              --   - each TickUpdate row also needs to know the last_cumulative_value
              -- this should get us the current token reserves of the event
              sum("ReservesZeroDeposited") OVER cumulative_window AS "TotalReservesZero",
              sum("ReservesOneDeposited") OVER cumulative_window AS "TotalReservesOne",
              -- "grouped by user"
              "Receiver"
            FROM spacebox.dex_message_event_lp_user_balance
            WINDOW cumulative_window AS (
              PARTITION BY
                "TokenZero", "TokenOne", "TickIndexZero", "TickIndexOne", "Fee"
              ORDER BY
                "height" ASC,
                "block_part_index" ASC,
                "tx_index" ASC,
                "event_index" ASC
              -- get all known values up to the row's point in time
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          )
          SELECT *
          FROM cumulative_shares
          -- todo: fix missing DepositLP from WASM events before height 19947000 issue
          WHERE height >= 19964191
            AND "Receiver" = 'neutron1jmpf37kfscaqe884nkmxa694nfnk4kt75gd4umf097uyvzz9ahlqnet797'
            AND "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
        ),
        lp_dex_balance_changes AS (
          -- WITH (
          --   ("event_index"        * toUInt256(1))
          --   + ("tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
          --   + ("block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
          --   + ("height"           * toUInt256(4722366482869645213696))
          -- ) as "version"
          SELECT
            -- max(height) OVER interval_window AS "last_height",
            "timestamp",
            "height",
            -- pool index keys
            "TokenZero", "TokenOne",
            -- reserve information
            -- Reserves
            ("ReservesZeroDeposited") AS "ReservesZero",
            ("ReservesOneDeposited") AS "ReservesOne",
            -- "grouped by user"
            "Receiver"
          FROM spacebox.dex_message_event_lp_user_balance
          -- todo: fix missing DepositLP from WASM events before height 19947000 issue
          WHERE height >= 19964191
            -- AND "Receiver" = 'neutron1jmpf37kfscaqe884nkmxa694nfnk4kt75gd4umf097uyvzz9ahlqnet797'
            -- AND "Receiver" = 'neutron1eqecswp0ajvlvf344k80c5w4c948zwg4lq3zgg6mdd20hcqef2mqd8rvca'
            AND "Receiver" = 'neutron1eqecswp0ajvlvf344k80c5w4c948zwg4lq3zgg6mdd20hcqef2mqd8rvca'
            AND "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
        ),
        bank_balance_changes AS (
          -- WITH (
          --   ("event_index"        * toUInt256(1))
          --   + ("tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
          --   + ("block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
          --   + ("height"           * toUInt256(4722366482869645213696))
          -- ) as "version"
          SELECT
            -- max(height) OVER interval_window AS "last_height",
            -- "timestamp",
            "height",
            -- pool index keys
            ${denom0} AS "TokenZero",
            ${denom1} AS "TokenOne",
            if("denom" = "TokenZero", "amount", 0) AS "ReservesZero",
            if("denom" = "TokenOne", "amount", 0) AS "ReservesOne",
            -- "grouped by user"
            "address" AS "Receiver"
          FROM spacebox.debs_and_creds
          WHERE "Receiver" = 'neutron1eqecswp0ajvlvf344k80c5w4c948zwg4lq3zgg6mdd20hcqef2mqd8rvca'
          AND "TokenZero" = ${denom0}
          AND "TokenOne" = ${denom1}
        ),
        total_balance_height_changes AS (
          -- WITH (
          --   ("event_index"        * toUInt256(1))
          --   + ("tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
          --   + ("block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
          --   + ("height"           * toUInt256(4722366482869645213696))
          -- ) as "version"
          SELECT
            -- max(height) OVER interval_window AS "last_height",
            -- "timestamp",
            "height",
            -- pool index keys
            "TokenZero", "TokenOne",
            -- reserve information
            -- sum reserves in each group then sum the sums over the pair window
            sum("BankReservesZero") AS "BankReservesZero",
            sum("BankReservesOne") AS "BankReservesOne",
            sum("DexReservesZero") AS "DexReservesZero",
            sum("DexReservesOne") AS "DexReservesOne",
            "BankReservesZero" + "DexReservesZero" AS "TotalReservesZero",
            "BankReservesOne" + "DexReservesOne" AS "TotalReservesOne",
            -- "grouped by user"
            "Receiver"
          FROM (
            SELECT
              "height",
              "TokenZero",
              "TokenOne",
              0 AS "BankReservesZero",
              0 AS "BankReservesOne",
              "ReservesZero" AS "DexReservesZero",
              "ReservesOne" AS "DexReservesOne",
              "Receiver"
            FROM lp_dex_balance_changes
            UNION ALL
            SELECT
              "height",
              "TokenZero",
              "TokenOne",
              "ReservesZero" AS "BankReservesZero",
              "ReservesOne" AS "BankReservesOne",
              0 AS "DexReservesZero",
              0 AS "DexReservesOne",
              "Receiver"
            FROM bank_balance_changes
          )
          GROUP BY "TokenZero", "TokenOne", "height", "Receiver"
        ),
        total_balance_height_timeseries AS (
          -- WITH (
          --   ("event_index"        * toUInt256(1))
          --   + ("tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
          --   + ("block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
          --   + ("height"           * toUInt256(4722366482869645213696))
          -- ) as "version"
          SELECT
            -- max(height) OVER interval_window AS "last_height",
            -- "timestamp",
            "height",
            -- pool index keys
            "TokenZero", "TokenOne",
            -- reserve information
            -- sum reserves in each group then sum the sums over the pair window
            sum("BankReservesZero") OVER user_pair_window AS "BankReservesZero",
            sum("BankReservesOne") OVER user_pair_window AS "BankReservesOne",
            sum("DexReservesZero") OVER user_pair_window AS "DexReservesZero",
            sum("DexReservesOne") OVER user_pair_window AS "DexReservesOne",
            "BankReservesZero" + "DexReservesZero" AS "TotalReservesZero",
            "BankReservesOne" + "DexReservesOne" AS "TotalReservesOne",
            -- "grouped by user"
            "Receiver"
          FROM total_balance_height_changes
          WHERE
            -- only include if there is no net change
            total_balance_height_changes."BankReservesZero" != 0 OR
            total_balance_height_changes."BankReservesOne" != 0 OR
            total_balance_height_changes."DexReservesZero" != 0 OR
            total_balance_height_changes."DexReservesOne" != 0
            -- (total_balance_height_changes."BankReservesZero" + total_balance_height_changes."DexReservesZero") != 0 OR
            -- (total_balance_height_changes."BankReservesOne" + total_balance_height_changes."DexReservesOne") != 0
          WINDOW user_pair_window AS (
            PARTITION BY
              -- partition to each user's pair deposit balance
              "TokenZero", "TokenOne", "Receiver"
            -- order by ascending event position within interval time
            ORDER BY
              "height" ASC
            -- get all known values up to the row's point in time
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )
        )
        SELECT * FROM lp_dex_balance_changes_of_all_pools
        WHERE height >= 19964191
        ORDER BY "height" ASC
        LIMIT ${
          // if user did not request a time period (default to last month)
          // then return only last needed rows to show all 24h changes
          request.query.period ? Math.min(limit, LIMIT_ROWS) : 1000
        }
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        // getRow: ({ time, TokenIn,TickIndex,Fee,TrancheKey,Reserves }) => ({ time, TokenIn,TickIndex,Fee,TrancheKey,Reserves}),
        getHeight: (data) => Number(data.at(0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add time units, convert tick index units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : { ...row, type: 'Int32' }
              )
          );
        },
        // flag as complete if there will be no data changes after this
        isComplete:
          !!unixTo && toUnixTime(currentHeight.data.at(0)?.time) > unixTo,
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
      }
    );
  }),
};
