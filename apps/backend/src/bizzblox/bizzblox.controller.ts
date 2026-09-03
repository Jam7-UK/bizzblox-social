import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import {
  BizzbloxAuthGuard,
  type BizzbloxVerifiedRequest,
} from './bizzblox-auth.guard';
import { BizzbloxTenantService } from './bizzblox-tenant.service';
import { EnsureTenantDto } from './dto/tenant.dto';

@Controller('/internal/bizzblox/v1')
@UseGuards(BizzbloxAuthGuard)
export class BizzbloxController {
  constructor(private readonly tenants: BizzbloxTenantService) {}

  @Post('/tenants\\:ensure')
  async ensureTenant(
    @Req() request: BizzbloxVerifiedRequest,
    @Body() body: EnsureTenantDto
  ) {
    const authority = request.bizzbloxAuth;
    if (!authority || authority.tenantHandle !== body.externalTenantHandle) {
      throw new UnauthorizedException();
    }
    const tenant = await this.tenants.ensureTenant({
      connectorRevision: authority.connectorRevision,
      externalTenantHandle: body.externalTenantHandle,
      idempotencyKey: body.idempotencyKey,
      idempotencyVersion: body.idempotencyVersion,
    });
    return Object.freeze({
      created: tenant.created,
      credentialVersion: tenant.credentialVersion,
      organizationProvenance: tenant.organizationProvenance,
      tenantCredential: tenant.tenantCredential,
      tenantHandle: tenant.tenantHandle,
    });
  }

  @Get('/tenants/:tenantHandle')
  async readTenant(
    @Req() request: BizzbloxVerifiedRequest,
    @Param('tenantHandle') tenantHandle: string
  ) {
    if (request.bizzbloxAuth?.tenantHandle !== tenantHandle) {
      throw new UnauthorizedException();
    }
    return this.tenants.readTenant(tenantHandle);
  }

  @Post('/tenants/:tenantHandle/cleanup')
  async cleanupSyntheticTenant(
    @Req() request: BizzbloxVerifiedRequest,
    @Param('tenantHandle') tenantHandle: string
  ) {
    const authority = request.bizzbloxAuth;
    if (
      authority?.operation !== 'tenant.cleanup' ||
      authority.tenantHandle !== tenantHandle ||
      !authority.organizationId ||
      !/^tenant_synthetic_[A-Za-z0-9_-]{1,103}$/.test(tenantHandle)
    ) {
      throw new UnauthorizedException();
    }
    return await this.tenants.cleanupSyntheticTenant(
      tenantHandle,
      authority.organizationId
    );
  }
}
