import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

// Create log file stream for production
function createLogStreams() {
  const streams: pino.StreamEntry[] = [
    // Always log to stdout
    { stream: process.stdout },
  ];

  // In production, also write to file
  if (config.nodeEnv === 'production') {
    const logsDir = process.env.LOGS_DIR || '/app/logs';

    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      try {
        fs.mkdirSync(logsDir, { recursive: true });
      } catch (err) {
        console.error(`Failed to create logs directory: ${logsDir}`, err);
      }
    }

    // Create daily log file
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(logsDir, `bot-${today}.log`);

    try {
      const fileStream = fs.createWriteStream(logFile, { flags: 'a' });
      streams.push({ stream: fileStream });
    } catch (err) {
      console.error(`Failed to create log file: ${logFile}`, err);
    }
  }

  return streams;
}

// Create logger with multistream in production, pretty print in development
export const logger = config.nodeEnv === 'development'
  ? pino({
      level: config.logLevel,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    })
  : pino(
      { level: config.logLevel },
      pino.multistream(createLogStreams())
    );

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
