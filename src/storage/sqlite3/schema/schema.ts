import db from '../db/db';

// Cosmos standard objects
import createTableBlock from './tables/block.sql';
import createTableTx from './tables/tx.sql';
import createTableTxMsg from './tables/tx_msg.sql';
import createTableTxResultEvents from './tables/tx_result.events.sql';

// Duality specific primitives
import createTableDexTokens from './tables/dex.tokens.sql';
import createTableDexPairs from './tables/dex.pairs.sql';

// Duality specific events
import createTableEventDeposit from './tables/event.DepositLP.sql';
import createTableEventWithdraw from './tables/event.WithdrawLP.sql';
import createTableEventPlaceLimitOrder from './tables/event.PlaceLimitOrder.sql';
import createTableEventTickUpdate from './tables/event.TickUpdate.sql';

// data derived from events
import createTableDerivedTickState from './tables/derived.tick_state.sql';
import createTableDerivedTxPriceData from './tables/derived.tx_price_data.sql';
import createTableDerivedTxVolumeData from './tables/derived.tx_volume_data.sql';

export default async function init() {
  // ensure correct import order for foreign keys to reference correctly
  const tableOrder = [
    // Cosmos standard objects
    createTableBlock,
    createTableTx,
    createTableTxMsg,
    createTableTxResultEvents,

    // Duality specific primitives
    createTableDexTokens,
    createTableDexPairs,

    // Duality specific events
    createTableEventDeposit,
    createTableEventWithdraw,
    createTableEventPlaceLimitOrder,
    createTableEventTickUpdate,

    // data derived from events
    createTableDerivedTickState,
    createTableDerivedTxPriceData,
    createTableDerivedTxVolumeData,
  ];

  // add each statement of each table separately and in order
  // as sqlite3 does not support multiple statements in one query
  // see: https://github.com/TryGhost/node-sqlite3/issues/304
  for (const statement of tableOrder.flatMap(splitSqlStatements)) {
    await db.run(statement);
  }
}

// split out SQL into separate SQL statements
function splitSqlStatements(sql: string): string[] {
  return (
    sql
      // remove all SQL comments
      .replace(/\/\*[\s\S]*?\*\//gm, '')
      // split statements
      .split(';')
      // remove surrounding whitespace of each statement
      .map((statement) => statement.trim())
      // remove zero-length statements
      .filter(Boolean)
  );
}
