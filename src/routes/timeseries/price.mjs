
import logger from '../../logger.mjs';
import getPricePerSecond from '../../storage/sqlite3/db/derived.tx_price_data/getPricePerSecond.mjs';

const routes = [

  {
    method: 'GET',
    path: '/timeseries/price/{tokenA}/{tokenB}',
    handler: async (request, h) => {
      try {
        return await getPricePerSecond(
          request.params['tokenA'],
          request.params['tokenB'],
          request.query, // the time extents and frequency and such
        );
      }
      catch (err) {
        logger.error(err);
        return h.response(`something happened: ${err.message || '?'}`).code(500);
      }
    },
  },

];

export default routes;
