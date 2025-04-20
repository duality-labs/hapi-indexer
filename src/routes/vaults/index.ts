import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { hours, inMs } from '../../utils/units';
import { selectVaultConfigs } from '../../common-table-expressions/vaultConfigs';

interface Request {
  params: { contract: string };
  query: {
    limit?: string;
  };
}
interface Response {
  time: string;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults',
  handler: async (request, abortSignal, previousResponse) => {
    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
      `,
      abortSignal
    );

    const currentHeight = await getCachedResponse<{ height: string }>(
      sql`
          SELECT max("height") AS "height"
          FROM spacebox."dex_vaults_message_event_create_denom"
        `,
      abortSignal
    );

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        SELECT
          "height",
          "timestamp" AS "time",
          "contract_address",
          "owner",
          "max_blocks_stale_token_a",
          "max_blocks_stale_token_b",
          "token_0_denom",
          "token_0_symbol",
          "token_0_quote_currency",
          "token_1_denom",
          "token_1_symbol",
          "token_1_quote_currency",
          "pool_id",
          "deposit_cap",
          "oracle_contract",
          "imbalance",
          "fee_tier_config",
          "timestamp_stale",
          "denom",
          "token_order"
        FROM (${selectVaultConfigs})
        -- TODO: join amount of tokens on either side, on dex or not (this will be approximate TVL)
        ${
          previousResponse
            ? // if this is an incremental update, get changes since known height
              sql`
                WHERE "height" > ${previousResponse.height}
              `
            : // else return all
              sql``
        }
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        getRow: ({ height, ...rest }) => rest,
        getHeight: (data) =>
          Number(data.find((row) => Number(row.height) > 0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add time units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : row
              )
          );
        },
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
      }
    );
  },
};
