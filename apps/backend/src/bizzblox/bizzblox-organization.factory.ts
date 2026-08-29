import { randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { BizzbloxOrganizationFactory } from './bizzblox-tenant.service';

@Injectable()
export class BizzbloxRuntimeOrganizationFactory
  implements BizzbloxOrganizationFactory
{
  createOrganization() {
    return Object.freeze({
      apiKey: `bbx_internal_${randomBytes(32).toString('base64url')}`,
      id: randomUUID(),
      provenance: `orgprov_${randomBytes(18).toString('base64url')}`,
    });
  }
}
