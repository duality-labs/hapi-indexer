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

- `pagination.before`
- `pagination.after`

### Serving Real-Time Data (long-polling)

for real-time requests a new standard set of query parameters have been used:

- `block_range.from_height`
- `block_range.to_height`

These parameters indicate whether the response should be on a specific range of data,
and if the chain height does not exist yet this implies that the response should
wait for new data before returning. These attributes are also returned in the
response body attributes to indicate the range of chain heights that the data is comprised of.

By requesting the initial route without `block_range` parameters and following
the response with new requests from the responded height recursively
(i.e. querying `block_range.from_height={currentKnownHeight}` with each returned
response body's `block_range.to_height`), we get long-polling real-time data.

### Serving Real-Time Data (HTTP/2 SSE)

Server-Sent Events (SSE) are a good choice for sending real-time data of a
constantly updating state of a resource: the user sends one request for one resource
and the server may respond with the whole resource at that point in time (or its
`block_range.from_height` update if requested) and after the initial data it may
send updates to that data for as long as the user keeps the connection open.

## Future Improvements

The indexer is a work in progress, and still many things are planned

- the current ingestion times for some Duality Dex transactions are quite high
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
This file will be needed for Docker environments but may be empty and automatically created.

For more details about available env vars see the current .env file in https://github.com/duality-labs/hapi-indexer/blob/main/.env.
An example is given here:

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

### VSCode + Dev Containers

1.  Open this code in VSCode with the
    [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
    extension installed, and select to "Reopen in container" when prompted
2.  The indexer should compile and start running immediately in a VSCode terminal
    - this process can be exited using `ctrl+c`
    - run `npm run dev` in the VSCode terminal to restart the indexer
3.  [optional] if you intend to commit to git in a process outside of VSCode:
    - use `npm ci` (with Node.js v18+) locally to install git hooks first

---

### Docker Compose

1.  have git installed
2.  have Node.js (v16/18+) installed (recommended: use [NVM](https://github.com/nvm-sh/nvm))
3.  use `npm ci` to install git hooks (and other dependencies)
4.  ensure you have a `.env.local` file with local environment settings you want to use
5.  use `npm run docker` to run the code in a Docker Compose container

---

### Local tools

1.  have git installed
1.  Ensure you have the correct Node.js version installed (refer to the Dockerfile node dependency)
1.  ensure you have a `.env.local` file with local environment settings you want to use
1.  use `npm ci` to install dependencies and git hooks
1.  use `npm start` to run the chain
    - environment variables should be made availble to this command
      - eg. using `NODE_ENV=development npm start`
      - see `.env` for example environment variables
    - if there are issues with the SQL driver file please refer to
      [the sqlite3 docs](https://github.com/TryGhost/node-sqlite3#source-install).
      The SQL driver binary must match the system it is running on.

## Difference between start scripts

- `npm start` will start the indexer
- `npm run dev` will start the indexer and also listen for code changes
  and restart the indexer on any detected changes to the JavaScript bundle,
  additionally the dev server will delete the DB file before each restart
  so that it can start with a clean state
