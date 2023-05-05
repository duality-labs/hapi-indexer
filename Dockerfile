# install node
# https://hub.docker.com/_/node/
FROM node:18-alpine

WORKDIR /usr/workspace

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

CMD npm start
