import { Injectable } from '@nestjs/common';

import { AuthService } from '../../../../libraries/helpers/src/auth/auth.service';

import type { BizzbloxCustomFieldSealer } from './bizzblox-connection-provider.gateway';

@Injectable()
export class PostizBizzbloxCustomFieldSealer
  implements BizzbloxCustomFieldSealer
{
  seal(fields: Readonly<Record<string, string>>): string {
    return AuthService.fixedEncryption(JSON.stringify(fields));
  }
}
