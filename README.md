# Neutron / Duality Dex hapi indexer

A Node.js based indexer for Duality Dex data on the [Neutron chain](https://github.com/neutron-org/neutron) made with the [Hapi](https://hapi.dev/) server framework
and with data stored in [SQLite3](https://www.sqlite.org/).

## Versioning

Please note that the package version of the indexer should match the release
version of the Neutron chain that the indexer is targeting in:
https://github.com/neutron-org/neutron/releases

## Quick Start

Clone/download this codebase and open it using VSCode with the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension installed. The indexer will start serving on https://localhost:8000 after the container is built.

Or see the [#get-started](#get-started) section for more options

## API Spec

The details of the API can be found at [API.md](https://github.com/duality-labs/hapi-indexer/blob/main/API.md).

## Goals

The Goals of the indexer are to:

- serve requests that are extremely inefficient to query on chain
  - eg. Duality Dex token pair historic prices (would require querying many txs of a pair to cover a large time period)
- serve requests for data that should update in real-time
  - eg. Duality Dex token pair price & liquidity depth (we want to see it change in real-time in the UI)

While doing this it would be preferable if it could also:

- should respond quickly
- should work simply and be easy to understand
- serve entire UI user base with a few indexer instances
- should be able to cache content easily for serving many identical requests
- depend only on the chain
  - all other dependencies (on centralized storage, or other indexer instances)
    are points of failure that should be avoided
  - should be able to spin up as many or as little indexers as desired at will

## Solution

The specific solution of this indexer is a combination of Node.js, the Hapi framework, and SQLite.

- Server: Node.js / Hapi
  - Node.js is able to handle high network traffic due to cheap context price for each served request
  - using JavaScript helps keep some types and calculations consistent across the front end
    - eg. the Duality "current price" algorithm is the same in the indexer and web app
  - decent handling of real-time tech: WebSockets / long-polling / SSE
  - Hapi is a simple framework for REST requests with JSON outputs
    - and it comes with a robuse caching utility
- Database: SQLite
  - SQLite is a simple database that is ideal in situations where it is read by only only process (like it is here)
  - SQLite can take advantage of SQL for complicated queries across structured data

### Solution Alternatives

But there are several other good alternatives that are possible to use

- Server:
  - GoLang would have been a sound choice:
  - it also can handle high network traffic
  - it can benefit from backend dev knowledge and also share backend logic
  - has direct access to application state DB, and also could work with
    CosmosSDK ADR-038: state listening and state streaming
    https://github.com/cosmos/cosmos-sdk/issues/10096
- Database:
  - Postgres is also a logical choice for SQL
  - ElasticSearch may be a reasonable DB to quickly query unstructured data

## Duality Indexer implementation

### Indexing Data

Much of the main serving and indexing functionality is application agnostic and exists in the root:

- src/server
- src/sync

Essentially `server.ts` and `sync.ts` could be abstracted into a Hapi plugin
that could look like this:

```ts
// or as a Hapi Plugin like this
server.register({
  plugin: HapiCosmosIndexerPlugin,
  options: {
    // settings to communicate to Cosmos chain
    RPC_ENDPOINT: RPC_API,
    REST_ENDPOINT: REST_API,
    // some exposed hooks for custom logic
    async beforeSync() {
      await initDb;
    },
    async onTx(tx: Tx) {
      // your application logic and storage opinions go here
    },
  },
});
```

The indexer plugin here will continually query the Chain for new transactions and pass them
to be handled in a callback by the application logic. It doesn't do much as a "plugin" except:

- it adds a root page (`/`) that shows the indexer status
- prevents other routes from responding until indexer is in sync with the chain

With the indexer processing incoming transactions into a database, the Hapi
server can be used as normally intended (to serve HTTP requests) for reading
data out of the stored database.

#### Indexed Data storage

All other src files and folders are specific Duality Dex logic. But the

- src/storage/sqlite/schema/tables
- src/storage/sqlite/ingest/tables

files very specifically set the Duality Dex indexer storage solution (SQLite) and
how to store each transaction into this database. The tables follow a layout
intended to represent fundamental chain objects:

- `block`: store block information
- `tx_msg_type`: store known transaction message types
- `tx`: store txs and reference `block`
- `tx_msg`: store the tx msg and references its `tx_msg_type`
- `tx_result.events`: store tx_results and reference `tx` and `tx_msg`
- each `event.{EventType}` table stores specific fields of each known event type and references `tx_result.events`
  The naming in these table and field names specifically reflects how the data
  looks when querying the chain for txs.

Then there are the application specific tables

- `dex.tokens`: fundamental object type in the dex
- `dex.pairs`: fundamental object type in the dex, references: `dex.tokens`

Then there are derived data tables. These tables are not direct storage or simple
transformed object storage of objects into tables. These tables required computation of
the state of the chain at each point of time of insertion to be able to recreate
the expected state of the chain. Eg. Duality historic price endpoints use the
`derived.tx_price_data` table to store the price of a pair in tx order, using this
data and some specific SQL queries it is possible to quickly get the OHLC
(Open/High/Low/Close) data for any requested period of time

### Serving Data

The rest of the logic in the indexer deals with responding to requests by fetching
data from the stored transactions. These requests may be cached or partially cached.
Pagination query parameter logic has been reimplemented with the same keys as
CosmosSDK:

- `pagination.offset`
- `pagination.limit`
- `pagination.next_key`
- `pagination.count_toal`

but we also add in new standard pagination parameters for timeseries timestamp limits:

- `pagination.before` (will be renamed to `block_range.to_timestamp`)
- `pagination.after` (will be renamed to `block_range.from_timestamp`)
- `block_range.from_timestamp`
- `block_range.to_timestamp`

### Serving Real-Time Data

For real-time requests a new set of query parameters have been created:

- `block_range.from_timestamp`
- `block_range.from_height`
- `block_range.to_height`

These parameters indicate that the response should be filtered to a specific range of data,
and if the queried chain height range does not exist yet this implies that the response should
wait for new data before returning. These attributes are also returned in the
response body attributes to indicate the chain height range of the response data.

#### Long Polling

A long-polling mechanism can be achieved by using the new `block_range` parameters like this:

1. By requesting an endpoint initial with no `block_range` parameters, we can get the current data state and also the latest block height in its returned `block_range.to_height` attribute.
2. If we take from the previous response `currentBlockHeight = block_range.to_height` and then make a new request with a `block_range.from_height={currentBlockHeight}` param filter, the API will delay sending a response until there is data available to show us a data update to that resource starting from the requesting `block_range.from_height`.
3. If we repeat step 2 (for as long as we want) and continue following the current data height recursively we get long-polled real-time data.

#### HTTP/2 Server-Sent Events (SSE)

By extending the logic of long-polling further, [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) are a good choice for sending real-time data of a constantly updating state of a resource: the user sends one request for one data resource and the server may respond with the resource state at that point in time (or the changes since a certain `block_range.from_height` or `block_range.from_timestamp` if requested) and after the initial data is sent it may continue sending updates of that data resources as long as the user keeps the connection open.

This feature works well for streaming new data on each block finalization, but also for streaming very large responses of an initial state as any response is able to be broken down into several small pages (streaming pagination pages).

This feature is only used after validating that the connection is able to use HTTP/2 SSE (is a HTTP/2 request).

#### Response caching

Most SQL data requests in the indexer are cached to IDs representing unique (and deterministic) request responses. In this way, multiple incoming requests from multiple users by request the same information and the SQL query and response is generated only once for each common request. For common endpoints such as `/liquidity/pairs` (which most users will be subscribed to with the app open) the response data will only be computed once per new block and the same response streamed to every subscribed user when ready.

### Optional Price Data

The approximate total value locked (TVL) in USD for each liquidity pair is used to sort the order of the liquidity pairs of the `/liquidity/pairs` endpoint. This is achieved through queries to CoinGecko using API keys passed in [ENV vars](#environment-variables).

This sorting feature is useful for the API to provide, but is not strictly required: a UI using the endpoint data can calculate USD values independently and re-sort an unsorted list of liquidity pairs.

This feature was added in PR: [#40](https://github.com/duality-labs/hapi-indexer/pull/40).

## Future Improvements

The indexer is a work in progress, and many things may still be improved:

- Use websockets to listen for block updates from the chain, instead of polling frequently to check if new transactions are available to process
- The current ingestion times for some Duality Dex transactions are quite high
  and we should attempt to make them quicker to allow greater practical
  transaction throughput of the chain.
  - the [timer log outputs](https://github.com/duality-labs/hapi-indexer/pull/33) when running the server suggests that the main issue in the processing times are the "get tick state" steps of processing data for both the `derived.tx_price_data` and `derived.tx_volume_data` tables.

# Requirements

- git version >= 2.9 (for git hooks usage)
- for simple development:
  - VSCode: https://code.visualstudio.com/
  - Docker + Docker compose: https://www.docker.com/products/docker-desktop/
- otherwise:
  - correct Node.js version: https://nodejs.org (or through [NVM](https://github.com/nvm-sh/nvm)))
  - [optional] Docker + Docker compose

# Get started

## Environment variables

You can customize your environment settings in a `.env.local` file defined.
This file will be needed for Docker environments but may be empty and automatically created. If not using Docker, the ENV vars should just be made available to the execution environment through any other usual means.

For more details about available ENV vars see the current .env file in https://github.com/duality-labs/hapi-indexer/blob/main/.env.
An example of local development ENV vars is given here:

```ini
# .env.local

# Add dev endpoints
NODE_ENV=development

# Connect to local chain served by a Docker container
# eg. by following the steps of https://docs.neutron.org/neutron/build-and-run/cosmopark
# - set up local repo folders by cloning from git
# - use Makefile https://github.com/neutron-org/neutron-integration-tests/blob/61353cf7f3e358c8e4b4d15c8c0c66be27efe11f/setup/Makefile#L16-L26
#   - to build: `make build-all`
#   - to run: `make start-cosmopark-no-rebuild`
#   - to stop: `make stop-cosmopark`
# this creates a Neutron chain that will be reachable to the indexer with env vars:
REST_API=http://host.docker.internal:1317
RPC_API=http://host.docker.internal:26657
WEBSOCKET_URL=ws://host.docker.internal:26657/websocket
```

## Development options:

### VSCode + Dev Containers (recommended)

By using the VSCode devcontainer you will automatically be able to see syntax highlighting for SQL in .sql and .ts files, provided by the defined VSCode extensions in the devcontainer settings file.

1.  Add any [ENV vars](#environment-variables) that you want into a .env.local file
1.  Open this code in VSCode with the
    [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
    extension installed, and select to "Reopen in container" when prompted
1.  The indexer should compile and start running immediately in a VSCode terminal
    - this process can be exited using `ctrl+c`
    - run `npm run dev` in the VSCode terminal to restart the indexer
1.  [optional] if you intend to commit to git in a process outside of VSCode:
    - use `npm ci` (with Node.js v18+) locally to install git hooks first

---

### Docker Compose

1.  have git installed
2.  have Node.js (v16/18+) installed (recommended: use [NVM](https://github.com/nvm-sh/nvm))
3.  use `npm ci` to install git hooks (and other dependencies)
4.  Add any [ENV vars](#environment-variables) that you want into a .env.local file
5.  use `npm run docker` to run the server in a Docker Compose container

---

### Local tools

To setup a dev environment without Docker, the setup can be completed as a [production without Docker](#without-docker) setup.

To restart the server after making code changes:

- run `npm run dev` instead of `npm start`
- or just kill the server (ctrl+c) and start it again with `npm run build && npm run start`

### Difference between start scripts

- `npm start` will start the indexer
- `npm run dev` will start the indexer and also listen for and rebuild code changes
  and restart the indexer on any detected changes to the JavaScript bundle,
  additionally the dev server will delete the DB file before each restart
  so that it can start with a clean state

## Running in production / CI

### In Docker

If using Docker images in production or CI, the [included Dockerfile](https://github.com/duality-labs/hapi-indexer/blob/main/Dockerfile) already provides steps to build an image with minimal dependencies

- `docker build -t hapi-indexer .`
- `docker run hapi-indexer`
  - any [ENV vars](#environment-variables) that you want should be made available to the container here
    (eg. through `--env` or `--env-file` options)

### Without Docker

To build the indexer for production the following steps may help:

1. Ensure requirements are met:
   - Node.js v18+ is required (check package.json for exact version)
   - git should not be required
2. Install dependencies with:
   - `npm run ci`
3. Build the distribution files with:
   - `npm run build`
4. Start the server with:
   - `npm start` (or `node dist/server.js`)
   - any needed [ENV vars](#environment-variables) should be made available in the execution environment for this step

#### Slimmer production build

Optionally for a slimmer production image most of the dependencies can be removed. In the example Dockerfile in https://github.com/duality-labs/hapi-indexer/blob/api-v2.0.0/Dockerfile:

- copy the built distribution files in the distribution directory (./dist/)
- copy any relevant SSL .pem files to serve HTTPS responses
- install the only required dependency sqlite3 (its a bit complicated to bundle)
  - `npm i --no-save sqlite3`
- run server with:
  - `node dist/server.js`
  - any needed [ENV vars](#environment-variables) should be made available in the execution environment for this step
