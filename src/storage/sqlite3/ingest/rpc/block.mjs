
import db from '../../db.mjs';

let insertTx;
async function insertBlockRows(block) {
  // activate at run time (after db has been initialized)
  insertTx = insertTx || db.prepare(`
    INSERT INTO 'block' (
      'header.height',
      'header.time',
      'header.time_unix'
    ) values (?, ?, ?, ?, ?)
  `);

  return new Promise((resolve, reject) => {
    insertTx.run([
      // 'header.height' INTEGER PRIMARY KEY NOT NULL,
      block.block.header.height,
      // 'header.time' TEXT NOT NULL,
      block.block.header.time,
      // 'header.time_unix' INTEGER UNIQUE NOT NULL
      Math.round(new Date(block.block.header.time).valueOf() / 1000),
    ], err => err ? reject(err) : resolve());
  });
}

export default async function ingestBlocks (blockPage) {
  return await Promise.all(blockPage.map(async block => {
    await insertBlockRows(block);
  }));
};
