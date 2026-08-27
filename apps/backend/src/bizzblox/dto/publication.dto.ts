import { IsDefined, IsObject } from 'class-validator';

import type { BizzbloxPublicationRequest } from '../bizzblox-publications.service';

export class BizzbloxPublicationDto implements BizzbloxPublicationRequest {
  @IsDefined()
  @IsObject()
  document: BizzbloxPublicationRequest['document'];

  @IsDefined()
  @IsObject()
  delivery: BizzbloxPublicationRequest['delivery'];
}
