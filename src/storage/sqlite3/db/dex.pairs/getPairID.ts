import db, { prepare } from '../db';
import { selectPairID } from './selectPairID';

// get pair ID without know which is token0 or token1
export default async function getPairID(tokenA: string, tokenB: string) {
  // wrap response in a promise
  const result = await db.get(...prepare(selectPairID(tokenA, tokenB)));
  // return found id
  return result?.['id'] || undefined;
}
