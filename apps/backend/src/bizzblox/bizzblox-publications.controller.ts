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
import { BizzbloxPublicationsService } from './bizzblox-publications.service';
import { BizzbloxPublicationDto } from './dto/publication.dto';

@Controller('/internal/bizzblox/v1')
@UseGuards(BizzbloxAuthGuard)
export class BizzbloxPublicationsController {
  constructor(private readonly publications: BizzbloxPublicationsService) {}

  private authority(request: BizzbloxVerifiedRequest, operation: string) {
    const authority = request.bizzbloxAuth;
    if (
      !authority?.organizationId ||
      authority.operation !== operation ||
      authority.connectorRevision < 1
    ) {
      throw new UnauthorizedException();
    }
    return authority;
  }

  @Post('/publications:validate')
  async validate(
    @Req() request: BizzbloxVerifiedRequest,
    @Body() body: BizzbloxPublicationDto
  ) {
    const authority = this.authority(request, 'publication.validate');
    return await this.publications.validate(
      authority.organizationId,
      authority.connectorRevision,
      body
    );
  }

  @Post('/publications')
  async schedule(
    @Req() request: BizzbloxVerifiedRequest,
    @Body() body: BizzbloxPublicationDto
  ) {
    const authority = this.authority(request, 'publication.schedule');
    return await this.publications.schedule(
      authority.organizationId,
      authority.connectorRevision,
      body
    );
  }

  @Get('/publications/by-external/:externalPublicationId')
  async read(
    @Req() request: BizzbloxVerifiedRequest,
    @Param('externalPublicationId') externalPublicationId: string
  ) {
    const authority = this.authority(request, 'publication.read');
    return await this.publications.read(
      authority.organizationId,
      authority.connectorRevision,
      externalPublicationId
    );
  }

  @Post('/publications/by-external/:externalPublicationId/cancel')
  async cancel(
    @Req() request: BizzbloxVerifiedRequest,
    @Param('externalPublicationId') externalPublicationId: string
  ) {
    const authority = this.authority(request, 'publication.cancel');
    return await this.publications.cancel(
      authority.organizationId,
      authority.connectorRevision,
      externalPublicationId
    );
  }

  @Get('/publications/by-external/:externalPublicationId/analytics')
  async analytics(
    @Req() request: BizzbloxVerifiedRequest,
    @Param('externalPublicationId') externalPublicationId: string
  ) {
    const authority = this.authority(request, 'publication.analytics.read');
    return await this.publications.analytics(
      authority.organizationId,
      authority.connectorRevision,
      externalPublicationId
    );
  }
}
