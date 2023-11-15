import sql from 'sql-template-tag';
import db, { prepare } from '../db';

export default async function getHeight(): Promise<number> {
  // wrap response in a promise
  const result = await db.get(
    ...prepare(sql`
      SELECT
        'block'.'header.height'
      FROM
        'block'
      ORDER BY 'block'.'id' DESC
      LIMIT 1
    `)
  );
  // return found height
  const height = Number(result?.['header.height']);
  if (height > 0) {
    return height;
  } else {
    throw new Error('Chain has no height');
  }
}

export async function getHeightAtTime(unixTimestamp: number): Promise<number> {
  if (!unixTimestamp) {
    return 0;
  }
  // wrap response in a promise
  const result = await db.get(
    ...prepare(sql`
      SELECT
        'block'.'header.height'
      FROM
        'block'
      WHERE
        'block'.'header.time_unix' <= ${unixTimestamp}
      ORDER BY 'block'.'id' DESC
      LIMIT 1
    `)
  );
  // return found height or unfound height (0)
  const height = Number(result?.['header.height']);
  return height || 0;
}
