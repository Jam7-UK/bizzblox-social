import { IsDefined, IsObject } from 'class-validator';

export class BizzbloxProviderHelperDto {
  @IsDefined()
  @IsObject()
  data: Readonly<Record<string, string>>;
}
