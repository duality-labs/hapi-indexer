# install node
# https://hub.docker.com/_/node/
FROM node:18-alpine

# create and set app directory
RUN mkdir -p /usr/src/app/
WORKDIR /usr/src/app/

# install app dependencies
# this is done before the following COPY command to take advantage of layer caching
COPY package.json .
RUN npm install

# copy app source to destination container
COPY . .

# expose container port
EXPOSE 8000

CMD npm start
