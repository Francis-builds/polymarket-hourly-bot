import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

// Log rotation settings
const MAX_LOG_SIZE_MB = 50;
const MAX_LOG_FILES = 5;

/**
 * Rotate log files when they exceed MAX_LOG_SIZE_MB
 */
function rotateLogFile(logFile: string): void {
  try {
    if (!fs.existsSync(logFile)) return;

    const stats = fs.statSync(logFile);
    const sizeMB = stats.size / (1024 * 1024);

    if (sizeMB < MAX_LOG_SIZE_MB) return;

    // Rotate files: .log.4 -> .log.5, .log.3 -> .log.4, etc.
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const oldFile = `${logFile}.${i}`;
      const newFile = `${logFile}.${i + 1}`;
      if (fs.existsSync(oldFile)) {
        if (i === MAX_LOG_FILES - 1) {
          fs.unlinkSync(oldFile); // Delete oldest
        } else {
          fs.renameSync(oldFile, newFile);
        }
      }
    }

    // Rotate current log
    fs.renameSync(logFile, `${logFile}.1`);
    console.log(`Rotated log file: ${logFile} (was ${sizeMB.toFixed(1)}MB)`);
  } catch (err) {
    console.error('Log rotation failed:', err);
  }
}

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

    // Check and rotate if needed
    rotateLogFile(logFile);

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
