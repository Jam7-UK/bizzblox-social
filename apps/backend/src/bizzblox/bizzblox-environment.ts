export const BIZZBLOX_SOCIAL_ENVIRONMENTS = ['dev', 'preprod', 'prod'] as const;

export type BizzbloxSocialEnvironment =
  (typeof BIZZBLOX_SOCIAL_ENVIRONMENTS)[number];

function environmentFromIdentifier(
  value: string,
  prefix: 'tenant' | 'idem'
): BizzbloxSocialEnvironment | null {
  const match = new RegExp(
    `^${prefix}_[A-Za-z0-9_-]{43}-(dev|preprod|prod)$`
  ).exec(value);
  return (match?.[1] as BizzbloxSocialEnvironment | undefined) ?? null;
}

export function socialEnvironmentFromTenantHandle(
  value: string
): BizzbloxSocialEnvironment | null {
  return environmentFromIdentifier(value, 'tenant');
}

export function socialEnvironmentFromIdempotencyKey(
  value: string
): BizzbloxSocialEnvironment | null {
  return environmentFromIdentifier(value, 'idem');
}
