import { createLogger, transports, config, format } from 'winston';

const logFilename = 'logs/combined.log.ansi';

export const logFileTransport = new transports.File({
  level: 'debug',
  filename: logFilename,
});
export const defaultLogger = createLogger({
  levels: config.npm.levels,
  format: format.combine(format.colorize(), format.simple()),
  transports: [new transports.Console(), logFileTransport],
});

export default defaultLogger;
