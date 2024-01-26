# install node
# https://hub.docker.com/_/node/
FROM node:18-alpine as build-env

RUN apk add openssl

WORKDIR /usr/workspace

COPY scripts scripts
RUN sh ./scripts/create-certs.sh
ARG SSL_FILES_DIRECTORY=
RUN if [ "$SSL_FILES_DIRECTORY" != "" ]; \
    then \
        cp -n *.pem /usr/workspace$SSL_FILES_DIRECTORY ;\
    fi

# install app dependencies
# this is done before the following COPY command to take advantage of layer caching
COPY package.json .
COPY package-lock.json .

# when `npm ci` is run with NODE_ENV=production it will ignore the dev dependencies
# which will make for a slimmer build size
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

# remove the husky git hook installation process in production
RUN [ "$NODE_ENV" == "production" ] && npm pkg delete scripts.prepare || exit 0

# install dependencies (and in production do not install devDependencies)
RUN NODE_ENV=${NODE_ENV} npm ci

# copy app source to destination container
COPY . .

# expose container port
EXPOSE 8000

# build bundled code
RUN npm run build

# start process in build-env if desired
CMD npm start


# return slimmer build
FROM node:18-alpine

WORKDIR /usr/workspace

# add dependencies not covered by esbuild process
RUN npm i --no-save sqlite3

# Copy over build files from build-env
COPY --from=build-env /usr/workspace/dist /usr/workspace/dist

# Copy SSL certs if defined from given SSL_FILES_DIRECTORY, or defaulting to CWD
ARG SSL_FILES_DIRECTORY=/
COPY --from=build-env /usr/workspace$SSL_FILES_DIRECTORY*.pem /usr/workspace$SSL_FILES_DIRECTORY

# start node
CMD node dist/server.js
