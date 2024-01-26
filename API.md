# Data delivery methods

## Short/Long Polling

The endpoints of the indexer can return regular request/response type data by sending requests of no special headers or query parameters, eg. `/liquidity/pairs`

To facilitate real-time requests, `block_range` attributes are returned to represent the block range of data response. If we the current block height from a previous response like `currentBlockHeight = block_range.to_height` and then make a new request with a `block_range.from_height={currentBlockHeight}` param filter, the API will delay sending a response until there is data available to show us a data update to that resource starting from the requesting `block_range.from_height`. If we repeat this continually, following the current data height recursively we get long-polled real-time data.

## Data Streaming

If any data request is made using a request header that matches `Accept: text/event-stream` or uses a query parameter `?stream=true` then the response will be sent as an event stream using [server-sent events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) that contain only the required updates to build the data (using each data row key), the specific shape of each data row is included in the initial response of the stream, see the response of eg. `liquidity/pairs?stream=true`.

# API Spec

## Endpoints

### Health

- `/` status check endpoint (should include but does not yet include indexed height)

### Liquidity

- `/liquidity/pairs` the TVL of each pair sorted by descending approximate USD value
- `/liquidity/pair/{tokenA}/{tokenB}` the accumulated reserves by tick index of a pair
  - tick index can be converted to price ratio using `priceBtoA = 1.0001^tickIndexBtoA`
    - `priceBtoA` is the factor to multiply by the price of tokenB to get the price of tokenA
    - `priceBtoA` can also be thought of as `(price of tokenA) / (price of token B)`
- `/liquidity/token/{tokenA}/{tokenB}` similar to the pair route but only return tokenA data

The path parameters `tokenA` and `tokenB` represent the chain base denoms of any token pair. You can get the token pair list with these denoms from the `/liquidity/pairs` endpoint.

> note: IBC tokens should be written with an encoded `/` character (eg. `ibc%2f2F115E7...`)

### Time Series

- `/timeseries/price/{tokenA}/{tokenB}/{resolution?}` price data grouped by resolution
  - returns open/high/low/close prices in `tickIndexBtoA` form
- `/timeseries/tvl/{tokenA}/{tokenB}/{resolution?}` TVL data grouped by resolution
  - returns reserves of tokenA and tokenB for each timestamp group
- `/timeseries/volume/{tokenA}/{tokenB}/{resolution?}` swap data grouped by resolution
  - returns reserves of tokenA and tokenB swapped at each timestamp group
  - returns fees accrued by swapping tokenA and tokenB at each timestamp group

All time series endpoints accept the following path parameters:

- `resolution` can be one of:
  - `second`
  - `minute` (default)
  - `hour`
  - `day`
  - `month`

### Time Series Statistics

- `/stats/price/volume/{tokenA}/{tokenB}` price data of last 24 hours and 24h before that
- `/stats/volatility/volume/{tokenA}/{tokenB}` volatility data of last 10 days and 10 days before that
  - volatility is just derived from price data (and could be done outside the indexer)
- `/stats/tvl/volume/{tokenA}/{tokenB}` TVL data of last 24 hours and 24h before that
- `/stats/stats/volume/{tokenA}/{tokenB}` swap data of last 24 hours and 24h before that

## Query Parameters

All liquidity and time series endpoints accept the following query parameters to facilitate querying only the data of the needed timeframe or block range

- replicated CosmosSDK REST API pagination parameters:
  - `pagination.key`: page key (base64 string key)
  - `pagination.offset`: page offset (number)
  - `pagination.limit`: page limit (number)
  - `pagination.count_total`: return item count (boolean) (not relevant to streams)
- additional block range query parameters
  - `pagination.before`: limits data to blocks before or equal to this timestamp
  - `pagination.after`: limits data to blocks after this timestamp
  - `block_range.from_timestamp`: will re-key `pagination.after` to here
  - `block_range.to_timestamp`: will re-key `pagination.before` to here
  - `block_range.from_height`: limits data to blocks after to this height
  - `block_range.to_height`: limits data to blocks before or equal to this height

# Front end Usage

Subscribing to data updates may seem complicated at first, given that the event stream returns partial updates and these updates need to be accumulated into a usable data state. A TypeScript implementation of a fetching event stream data and subscribing to data using hooks is available in NPM package [https://www.npmjs.com/package/@duality-labs/duality-front-end-sdk](https://www.npmjs.com/package/@duality-labs/duality-front-end-sdk).

This exposes functions:

- `useIndexerStreamOfSingleDataSet<DataRow>`
- `useIndexerStreamOfDualDataSet<DataRow>`
- `fetchSingleDataSetFromIndexer<DataRow>`
- `fetchDualDataSetFromIndexer<DataRow>`

and underlying classes:

- `IndexerStream<DataRow>`
- `IndexerStreamAccumulateSingleDataSet<DataRow, DataSet>`
- `IndexerStreamAccumulateDualDataSet<DataRow, DataSet>`

where `DataRow` allows a TypeScript interface describing the row data shape to return typed data

## Examples

Examples of the front end SDK package can be found in [https://github.com/duality-labs/duality-front-end-sdk/tree/main?tab=readme-ov-file#indexer-usage-examples](https://github.com/duality-labs/duality-front-end-sdk/tree/main?tab=readme-ov-file#indexer-usage-examples).
