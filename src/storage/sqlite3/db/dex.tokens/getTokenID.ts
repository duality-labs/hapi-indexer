import db, { prepare } from '../db';
import { selectTokenID } from './selectTokenID';

// get token ID
export default async function getTokenID(token: string) {
  // wrap response in a promise
  const result = await db.get(...prepare(selectTokenID(token)));
  // return found id
  return result?.['id'] || undefined;
}
