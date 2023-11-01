import sql from 'sql-template-strings';

export default function getLatestTickStateCTE(
  token0: string,
  token1: string,
  token: string,
  {
    fromHeight,
    toHeight,
  }: {
    fromHeight: number;
    toHeight: number;
  }
) {
  return sql`
    WITH 'latest.derived.tick_state' AS (
      SELECT *
      FROM 'derived.tick_state'
      WHERE (
        'derived.tick_state'.'related.dex.pair' = (
          SELECT
            'dex.pairs'.'id'
          FROM
            'dex.pairs'
          WHERE (
            'dex.pairs'.'token0' = ${token0} AND
            'dex.pairs'.'token1' = ${token1}
          )
        ) AND
        'derived.tick_state'.'related.dex.token' = (
          SELECT
            'dex.tokens'.'id'
          FROM
            'dex.tokens'
          WHERE (
            'dex.tokens'.'token' = ${token}
          )
        ) AND
        'derived.tick_state'.'related.block.header.height' > ${fromHeight} AND
        'derived.tick_state'.'related.block.header.height' <= ${toHeight}
      )
      GROUP BY 'derived.tick_state'.'TickIndex'
      HAVING max('derived.tick_state'.'related.block.header.height')
    )
  `;
}
