type ConsoleTarget = {
  debug: (...args: unknown[]) => unknown;
  error: (...args: unknown[]) => unknown;
  info: (...args: unknown[]) => unknown;
  log: (...args: unknown[]) => unknown;
  warn: (...args: unknown[]) => unknown;
};

const installed = new WeakSet<object>();

export function installManagedRuntimeLogBoundary(
  target: ConsoleTarget = console
): void {
  if (installed.has(target)) return;
  installed.add(target);
  const event = target.log.bind(target);
  const info = target.info.bind(target);
  const debug = target.debug.bind(target);
  const warning = target.warn.bind(target);
  const error = target.error.bind(target);

  target.log = () => event('Managed runtime event; details redacted.');
  target.info = () => info('Managed runtime event; details redacted.');
  target.debug = () => debug('Managed runtime event; details redacted.');
  target.warn = () => warning('Managed runtime warning; details redacted.');
  target.error = () => error('Managed runtime error; details redacted.');
}
