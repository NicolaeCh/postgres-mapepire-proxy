type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly minLevel: Level = 'info') {}

  private emit(level: Level, message: string, fields: object = {}): void {
    if (order[level] < order[this.minLevel]) return;
    const record = { ts: new Date().toISOString(), level, message, ...fields };
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(message: string, fields?: object) { this.emit('debug', message, fields); }
  info(message: string, fields?: object) { this.emit('info', message, fields); }
  warn(message: string, fields?: object) { this.emit('warn', message, fields); }
  error(message: string, fields?: object) { this.emit('error', message, fields); }
}
