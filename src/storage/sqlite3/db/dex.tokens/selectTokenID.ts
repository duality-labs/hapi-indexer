import sql from 'sql-template-tag';

export function selectTokenID(token: string) {
  return sql`
    SELECT
      'dex.tokens'.'id'
    FROM
      'dex.tokens'
    WHERE (
      'dex.tokens'.'token' = ${token}
    )
  `;
}
