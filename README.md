# Duality hapi-indexer

A Node.js based indexer for the Duality Cosmos chain made with the [Hapi](https://hapi.dev/) server framework
and with data stored in [SQLite3](https://www.sqlite.org/).

# Requirements

- git version >= 2.9 (for git hooks usage)
- for simple development:
  - VSCode: https://code.visualstudio.com/
  - Docker + Docker compose: https://www.docker.com/products/docker-desktop/
- otherwise:
  - correct Node.js version: https://nodejs.org
  - [optional] Docker + Docker compose

# Get started

To get started with a local version of the chain:

1. make sure you have a local environment settings file defined.
   The following Docker steps will not work without one.

   ```ini
   # .env.local

   # Add dev endpoints
   NODE_ENV=development

   # Connect to local chain served by a Docker container
   # eg. https://github.com/duality-labs/dualityd-docker-services
   REST_API=http://host.docker.internal:1317
   RPC_API=http://host.docker.internal:26657
   WEBSOCKET_URL=ws://host.docker.internal:26657/websocket
   ```

2. Pick an development style option:

   ### VSCode + Dev Containers

   1. Open this code in VSCode with the
      [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
      extension installed, and select to "Reopen in container" when prompted
   2. run `npm start` in the VSCode terminal to start the indexer
   3. [optional] if you intend to git outside of VSCode
      - use `npm ci` (with Node.js v16+) locally to install git hooks

   ***

   ### Docker Compose

   1. have Node.js (v16+) installed locally
   2. use `npm ci` to install git hooks locally
   3. use `npm run docker` to run the code in a Docker Compose container

   ***

   ### Local tools

   1. Ensure you have the correct Node.js version installed (refer to the Dockerfile node dependency)
   2. use `npm ci` to install dependencies and git hooks
   3. use `npm start` to run the chain
      - environment variables should be made availble to this command
        - eg. using `NODE_ENV=development npm start`
        - see `.env` for example environment variables
      - if there are issues with the SQL driver file please refer to the specific installation workaround detailed in the Dockerfile. The SQL driver must match the system it is running on.
