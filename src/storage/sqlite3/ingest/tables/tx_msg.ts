import sql from 'sql-template-tag';

import db, { prepare } from '../../db/db';
import { DecodedTxEvent } from '../utils/decodeEvent';

export default async function insertMsgRows(txEvent: DecodedTxEvent) {
  const action = txEvent.attributes['action'];
  const actionPath = action?.startsWith('/') && action.slice(1).split('.');

  // get actions that look like standard actions
  if (
    action &&
    actionPath &&
    actionPath.length > 1 &&
    actionPath.pop()?.startsWith('Msg')
  ) {
    // add a new Msg
    return db.run(
      ...prepare(sql`
      INSERT OR IGNORE INTO 'tx_msg' (
        'related.tx_msg_type'
      ) values (
        (
          SELECT
            'tx_msg_type'.'id'
          FROM
            'tx_msg_type'
          WHERE (
            'tx_msg_type'.'action' = ${action.slice(1)}
          )
        )
      )
      `)
    );
  }
}
