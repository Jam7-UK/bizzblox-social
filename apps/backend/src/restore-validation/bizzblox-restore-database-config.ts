import { RestoreProbeError } from './bizzblox-restore-probe';

type RestoreDatabaseEnvironment = Readonly<Record<string, string | undefined>>;

function fail(): never {
  throw new RestoreProbeError();
}

function field(
  environment: RestoreDatabaseEnvironment,
  name: string,
  maximumLength: number
): string {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return fail();
  }
  return value;
}

function hostname(value: string): string {
  if (
    value.length > 253 ||
    !value.includes('.') ||
    value
      .split('.')
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
      )
  ) {
    return fail();
  }
  return value;
}

/** Builds an in-memory Prisma datasource URL from isolated ECS task fields. */
export function restoreDatabaseUrlFromEnvironment(
  environment: RestoreDatabaseEnvironment
): string {
  const host = hostname(field(environment, 'DATABASE_HOST', 253));
  const port = field(environment, 'DATABASE_PORT', 5);
  const portNumber = Number(port);
  if (
    !/^[0-9]{1,5}$/u.test(port) ||
    !Number.isInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65_535
  ) {
    return fail();
  }
  const database = field(environment, 'DATABASE_NAME', 63);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(database)) return fail();
  const username = field(environment, 'DATABASE_USERNAME', 128);
  const password = field(environment, 'DATABASE_PASSWORD', 1_024);
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(
    password
  )}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
}
