import {
  IsDefined,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class BizzbloxBeginConnectionDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,99}$/)
  provider: string;

  @IsString()
  @Matches(/^[A-Za-z0-9:_-]{16,256}$/)
  userBinding: string;

  @IsOptional()
  @IsObject()
  fields?: Readonly<Record<string, string>>;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  manualCode?: string;
}

export class BizzbloxSelectConnectionDto {
  @IsString()
  @Matches(/^[A-Za-z0-9:_-]{16,256}$/)
  userBinding: string;

  @IsString()
  @MaxLength(2_048)
  attemptHandle: string;

  @IsString()
  @MaxLength(2_048)
  optionRef: string;
}

export class BizzbloxDisconnectConnectionDto {
  @IsString()
  @Matches(/^bbx_ch_[A-Za-z0-9_-]{8,256}$/)
  channelHandle: string;
}

export class BizzbloxReconnectConnectionDto {
  @IsString()
  @Matches(/^bbx_ch_[A-Za-z0-9_-]{8,256}$/)
  channelHandle: string;

  @IsString()
  @Matches(/^[A-Za-z0-9:_-]{16,256}$/)
  userBinding: string;

  @IsOptional()
  @IsObject()
  fields?: Readonly<Record<string, string>>;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  manualCode?: string;
}

export class BizzbloxConnectionOutcomeDto {
  @IsString()
  @Matches(/^[A-Za-z0-9:_-]{16,256}$/)
  userBinding: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{32,256}$/)
  outcomeHandle: string;
}

export class BizzbloxProviderHelperDto {
  @IsDefined()
  @IsObject()
  data: Readonly<Record<string, string>>;
}
