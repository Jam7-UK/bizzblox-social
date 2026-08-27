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
  @MaxLength(2_048)
  attemptHandle: string;

  @IsString()
  @MaxLength(2_048)
  optionRef: string;
}

export class BizzbloxProviderHelperDto {
  @IsDefined()
  @IsObject()
  data: Readonly<Record<string, string>>;
}
