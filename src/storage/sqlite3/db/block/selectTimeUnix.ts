import sql from 'sql-template-tag';

export function selectTimeUnixAtOrBeforeBlockHeight(height: number) {
  return sql`
    IFNULL(
      (
        SELECT
          'block'.'header.time_unix'
        FROM
          'block'
        WHERE
          'block'.'header.height' <= ${height}
        ORDER BY 'block'.'header.height' DESC
        LIMIT 1
      ),
      0
    )
  `;
}

export function selectTimeUnixAfterBlockHeight(height: number) {
  return sql`
    IFNULL(
      (
        SELECT
          'block'.'header.time_unix'
        FROM
          'block'
        WHERE
          'block'.'header.height' > ${height}
        ORDER BY 'block'.'header.height' ASC
        LIMIT 1
      ),
      ${
        height > 0
          ? // is fromHeight too high? return from after last block
            sql`(${selectLastTimeUnix()}) + 1`
          : // is fromHeight too low? return from first block
            sql`0`
      }
    )
  `;
}

export function selectLastTimeUnix() {
  return sql`
    SELECT
      'block'.'header.time_unix'
    FROM
      'block'
    ORDER BY 'block'.'header.height' DESC
    LIMIT 1
  `;
}
