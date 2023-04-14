import db from './db.mjs'
import schema from './schema.mjs'

export async function init() {
  await schema();
}

export async function close() {
  return new Promise((resolve, reject) => {
    db.close(err => err ? reject(err) : resolve());
  });
}
