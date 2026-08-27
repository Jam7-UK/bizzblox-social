import { Equals, IsInt, IsString, Matches } from 'class-validator';

export class EnsureTenantDto {
  @IsString()
  @Matches(/^tenant_[A-Za-z0-9_-]{8,120}$/)
  externalTenantHandle: string;

  @IsString()
  @Matches(/^idem_[A-Za-z0-9_-]{16,120}$/)
  idempotencyKey: string;

  @IsInt()
  @Equals(1)
  idempotencyVersion: 1;
}
