import { readFileSync, existsSync } from 'fs';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

/** Variables only the browser-facing Postiz frontend reads; the headless BizzBLOX service never uses them. */
const FRONTEND_ONLY_URLS = ['MAIN_URL', 'BACKEND_INTERNAL_URL'] as const;

export class ConfigurationChecker {
  cfg: dotenv.DotenvParseOutput;
  issues: string[] = [];

  readEnvFromFile() {
    const envFile = resolve(__dirname, '../../../.env');

    if (!existsSync(envFile)) {
      console.error('Env file not found!: ', envFile);
      return;
    }

    const handle = readFileSync(envFile, 'utf-8');

    this.cfg = dotenv.parse(handle);
  }

  readEnvFromProcess() {
    this.cfg = process.env;
  }

  check() {
    this.checkDatabaseServers();
    this.checkNonEmpty('JWT_SECRET');
    this.checkIsValidUrl('FRONTEND_URL');
    this.checkIsValidUrl('NEXT_PUBLIC_BACKEND_URL');
    if (!this.isServiceMode()) {
      for (const key of FRONTEND_ONLY_URLS) this.checkIsValidUrl(key);
    }
    this.checkNonEmpty('STORAGE_PROVIDER', 'Needed to setup storage.');
  }

  /** BIZZBLOX_SERVICE_MODE=1 runs the API headless behind the branded callback and IAM gateway. */
  isServiceMode() {
    return this.get('BIZZBLOX_SERVICE_MODE') === '1';
  }

  checkNonEmpty(key: string, description?: string): boolean {
    const v = this.get(key);

    if (!description) {
      description = '';
    }

    if (!v) {
      this.issues.push(key + ' not set. ' + description);
      return false;
    }

    if (v.length === 0) {
      this.issues.push(key + ' is empty.' + description);
      return false;
    }

    return true;
  }

  get(key: string): string | undefined {
    return this.cfg[key as keyof typeof this.cfg];
  }

  checkDatabaseServers() {
    this.checkRedis();
    this.checkIsValidUrl('DATABASE_URL');
  }

  checkRedis() {
    if (!this.cfg.REDIS_URL) {
      this.issues.push('REDIS_URL not set');
    }

    try {
      const redisUrl = new URL(this.cfg.REDIS_URL);

      // ioredis accepts both schemes; rediss:// is TLS (in-transit encryption on ElastiCache).
      if (redisUrl.protocol !== 'redis:' && redisUrl.protocol !== 'rediss:') {
        this.issues.push('REDIS_URL must start with redis:// or rediss://');
      }
    } catch (error) {
      this.issues.push('REDIS_URL is not a valid URL');
    }
  }

  checkIsValidUrl(key: string) {
    if (!this.checkNonEmpty(key)) {
      return;
    }

    const urlString = this.get(key);

    try {
      new URL(urlString);
    } catch (error) {
      this.issues.push(key + ' is not a valid URL');
    }

    if (urlString.endsWith('/')) {
      this.issues.push(key + ' should not end with /');
    }
  }

  hasIssues() {
    return this.issues.length > 0;
  }

  getIssues() {
    return this.issues;
  }

  getIssuesCount() {
    return this.issues.length;
  }
}
