import sql from 'sql-template-tag';
import { selectTokenID } from '../dex.tokens/selectTokenID';
import { selectSortedPairID } from '../dex.pairs/selectPairID';

export default function selectLatestTickState(
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
      SELECT *
      FROM 'derived.tick_state'
      WHERE (
        'derived.tick_state'.'related.dex.pair' = (${selectSortedPairID(
          token0,
          token1
        )}) AND
        'derived.tick_state'.'related.dex.token' = (${selectTokenID(token)}) AND
        'derived.tick_state'.'related.block.header.height' > ${fromHeight} AND
        'derived.tick_state'.'related.block.header.height' <= ${toHeight}
      )
      GROUP BY 'derived.tick_state'.'TickIndex', 'derived.tick_state'.'Fee'
      HAVING max('derived.tick_state'.'related.block.header.height')
  `;
}

export function selectTickIndexesOfTickState(
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
      SELECT 'derived.tick_state'.'TickIndex'
      FROM 'derived.tick_state'
      WHERE (
        'derived.tick_state'.'related.dex.pair' = (${selectSortedPairID(
          token0,
          token1
        )}) AND
        'derived.tick_state'.'related.dex.token' = (${selectTokenID(token)}) AND
        'derived.tick_state'.'related.block.header.height' > ${fromHeight} AND
        'derived.tick_state'.'related.block.header.height' <= ${toHeight}
      )
  `;
}
