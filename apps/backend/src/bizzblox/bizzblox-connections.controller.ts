import {
  BadRequestException,
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
import {
  BizzbloxContractInputError,
  BizzbloxContractService,
} from './bizzblox-contract.service';
import { BizzbloxProviderHelperDto } from './dto/connection.dto';

@Controller('/internal/bizzblox/v1')
@UseGuards(BizzbloxAuthGuard)
export class BizzbloxConnectionsController {
  constructor(private readonly contracts: BizzbloxContractService) {}

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

  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BizzbloxContractInputError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Get('/channels')
  async list(@Req() request: BizzbloxVerifiedRequest) {
    const authority = this.authority(request, 'channel.list');
    return await this.safe(async () =>
      this.contracts.listChannels(
        authority.organizationId!,
        authority.connectorRevision
      )
    );
  }

  @Get('/channels/:channelHandle/contract')
  async contract(
    @Req() request: BizzbloxVerifiedRequest,
    @Param('channelHandle') channelHandle: string
  ) {
    const authority = this.authority(request, 'channel.contract.read');
    return await this.safe(async () =>
      this.contracts.readContract(
        authority.organizationId!,
        authority.connectorRevision,
        channelHandle
      )
    );
  }

  @Post('/channels/:channelHandle/tools/:helperRef')
  async helper(
    @Req() request: BizzbloxVerifiedRequest,
    @Param('channelHandle') channelHandle: string,
    @Param('helperRef') helperRef: string,
    @Body() body: BizzbloxProviderHelperDto
  ) {
    const authority = this.authority(request, 'channel.helper.execute');
    return await this.safe(async () =>
      this.contracts.executeHelper(
        authority.organizationId!,
        authority.connectorRevision,
        channelHandle,
        helperRef,
        body.data
      )
    );
  }
}
