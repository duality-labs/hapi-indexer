# Duality hapi-indexer

A Node.js based indexer for the Duality Cosmos chain made with the [Hapi](https://hapi.dev/) server framework
and with data stored in [SQLite3](https://www.sqlite.org/).

# Get started

To get started

```sh
# install (npm ci will not update dependencies and package-lock.json)
npm ci
# run
npm run docker
```

To connect to a locally running chain in Docker remember to add some local environment settings like this example:
.env.local

```.env
# Add dev endpoints
NODE_ENV=development

# Connect to local chain in Docker
REST_API=http://host.docker.internal:1317
RPC_API=http://host.docker.internal:26657
WEBSOCKET_URL=ws://host.docker.internal:26657/websocket
```
