import Hapi from '@hapi/hapi';

const init = async () => {

  const server = Hapi.server({
    port: 8000,
    // host: 0.0.0.0 resolves better than host: localhost in a Docker container
    host: '0.0.0.0',
  });

  server.route({
    method: 'GET',
    path: '/',
    handler: () => 'ok',
  });

  await server.start();
  console.log('Server running on %s', server.info.uri);
};

process.on('unhandledRejection', (err) => {
  console.log(err);
  process.exit(1);
});

init();
