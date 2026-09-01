import { IsIn, IsInt, IsString, Matches } from 'class-validator';

export class EnsureTenantDto {
  @IsString()
  @Matches(
    /^(?:tenant_[A-Za-z0-9_-]{43}-(?:dev|preprod|prod)|tenant_synthetic_[A-Za-z0-9_-]{1,103})$/
  )
  externalTenantHandle: string;

  @IsString()
  @Matches(/^idem_[A-Za-z0-9_-]{16,120}$/)
  idempotencyKey: string;

  @IsInt()
  @IsIn([1, 2])
  idempotencyVersion: 1 | 2;
}
