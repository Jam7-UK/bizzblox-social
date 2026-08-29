export function socialCallbackUrl(
  provider: string,
  managedCallbackUrl: string | undefined,
  legacyCallbackUrl: string
): string {
  if (!managedCallbackUrl) return legacyCallbackUrl;
  const callback = new URL(managedCallbackUrl);
  if (
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(provider) ||
    callback.protocol !== 'https:' ||
    callback.origin !== 'https://social.bizzblox.com' ||
    callback.pathname !== `/oauth/bizzblox/callback/${provider}` ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  ) {
    throw new Error('Invalid managed social callback URL.');
  }
  if (provider === 'tiktok-business') callback.pathname += '/';
  return callback.toString();
}
