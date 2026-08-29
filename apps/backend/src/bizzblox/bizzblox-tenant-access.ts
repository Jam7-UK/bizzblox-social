import { timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { BizzbloxTenantAccess } from './bizzblox-auth.guard';
import {
  BIZZBLOX_TENANT_CREDENTIALS,
  BIZZBLOX_TENANT_STORE,
  type BizzbloxTenantCredentials,
  type BizzbloxTenantStore,
} from './bizzblox-tenant.service';

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

@Injectable()
export class PrismaBizzbloxTenantAccess implements BizzbloxTenantAccess {
  constructor(
    @Inject(BIZZBLOX_TENANT_STORE)
    private readonly tenants: BizzbloxTenantStore,
    @Inject(BIZZBLOX_TENANT_CREDENTIALS)
    private readonly credentials: BizzbloxTenantCredentials
  ) {}

  async verifyCredential(tenantHandle: string, credential: string) {
    const tenant = await this.tenants.read(tenantHandle);
    if (
      !tenant ||
      !equalHash(
        tenant.credentialHash,
        this.credentials.hashCredential(credential)
      )
    ) {
      return null;
    }
    return Object.freeze({
      connectorRevision: tenant.connectorRevision,
      credentialVersion: tenant.credentialVersion,
      organizationId: tenant.organizationId,
    });
  }
}
