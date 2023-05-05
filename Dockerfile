# install node
# https://hub.docker.com/_/node/
# ensure using bullseye (Debian) as its friendly with source building on M1 Macs :')
FROM node:18-bullseye

# install app dependencies
# this is done before the following COPY command to take advantage of layer caching
COPY package.json .
COPY package-lock.json .

# when `npm ci` is run with NODE_ENV=production it will ignore the dev dependencies
# which will make for a slimmer build size
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
RUN NODE_ENV=${NODE_ENV} npm ci

# using build from source will allow the DB engine packages to build their own files
# and not rely on possibly incorrect downloaded versions
RUN cd node_modules/sqlite3 && \
    npm install --build-from-source --target_platform=linux --target_libc=glibc

# copy app source to destination container
COPY . .

# expose container port
EXPOSE 8000

CMD npm start
