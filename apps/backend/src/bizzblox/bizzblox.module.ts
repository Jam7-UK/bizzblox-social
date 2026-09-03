import { hkdfSync, randomBytes, randomUUID } from 'node:crypto';

import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

import {
  BIZZBLOX_AUTH_CONFIG,
  BIZZBLOX_CLAIM_VERIFIER,
  BIZZBLOX_REPLAY_STORE,
  BIZZBLOX_TENANT_ACCESS,
  BizzbloxAuthGuard,
  type BizzbloxAuthConfig,
} from './bizzblox-auth.guard';
import { BizzbloxJwtClaimVerifier } from './bizzblox-claim';
import {
  BIZZBLOX_SOCIAL_ENVIRONMENTS,
  type BizzbloxSocialEnvironment,
} from './bizzblox-environment';
import {
  BIZZBLOX_CHANNEL_DATABASE,
  PrismaBizzbloxChannelDirectory,
} from './bizzblox-channel.directory';
import {
  BIZZBLOX_CUSTOM_FIELD_SEALER,
  PostizBizzbloxConnectionProviderGateway,
} from './bizzblox-connection-provider.gateway';
import {
  BIZZBLOX_CONNECTION_STATE_CODEC,
  BizzbloxConnectionStateCodec,
  RedisBizzbloxConnectionStateStore,
} from './bizzblox-connection-state.store';
import { BizzbloxConnectionsController } from './bizzblox-connections.controller';
import {
  BIZZBLOX_CONNECTION_CONFIG,
  BIZZBLOX_CONNECTION_PROVIDERS,
  BIZZBLOX_CONNECTION_STATES,
  type BizzbloxConnectionConfig,
  BizzbloxConnectionsService,
} from './bizzblox-connections.service';
import {
  BIZZBLOX_CHANNEL_DIRECTORY,
  BIZZBLOX_OPAQUE_REFS,
  BizzbloxContractService,
  BizzbloxHmacOpaqueRefs,
} from './bizzblox-contract.service';
import { BizzbloxController } from './bizzblox.controller';
import { PostizBizzbloxCustomFieldSealer } from './bizzblox-custom-field.sealer';
import {
  BIZZBLOX_MEDIA_DATABASE,
  PrismaBizzbloxMediaStore,
} from './bizzblox-media.store';
import { BizzbloxPublicationsController } from './bizzblox-publications.controller';
import {
  BIZZBLOX_CHANNEL_ACCESS,
  BIZZBLOX_MEDIA_STORE,
  BIZZBLOX_POSTIZ_CLIENTS,
  BIZZBLOX_PUBLICATION_IDS,
  BIZZBLOX_PUBLICATION_STORE,
  BizzbloxPublicationsService,
} from './bizzblox-publications.service';
import {
  BIZZBLOX_PUBLICATION_DATABASE,
  PrismaBizzbloxChannelAccess,
  PrismaBizzbloxPublicationStore,
} from './bizzblox-publication.store';
import { BizzbloxPostizClientFactory } from './bizzblox-postiz-client.factory';
import {
  applyBizzbloxIamContext,
  BizzbloxIamContextMiddleware,
} from './bizzblox-iam.middleware';
import { BizzbloxHealthController } from './bizzblox-health.controller';
import { BizzbloxRuntimeOrganizationFactory } from './bizzblox-organization.factory';
import { BizzbloxOAuthController } from './bizzblox-oauth.controller';
import {
  BIZZBLOX_REDIS,
  RedisBizzbloxReplayStore,
} from './bizzblox-replay.store';
import { PrismaBizzbloxTenantAccess } from './bizzblox-tenant-access';
import { BizzbloxTenantCredentialCodec } from './bizzblox-tenant-credentials';
import {
  BIZZBLOX_ORGANIZATION_FACTORY,
  BIZZBLOX_TENANT_CREDENTIALS,
  BIZZBLOX_TENANT_STORE,
  BizzbloxTenantService,
} from './bizzblox-tenant.service';
import {
  BIZZBLOX_TENANT_DATABASE,
  PrismaBizzbloxTenantStore,
} from './bizzblox-tenant.store';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`Missing BizzBLOX service configuration: ${name}`);
  return value;
}

type BizzbloxRuntimeAuthConfig = BizzbloxAuthConfig &
  Readonly<{
    environments: Readonly<
      Record<
        BizzbloxSocialEnvironment,
        Readonly<{ issuer: string; publicKey: string }>
      >
    >;
    synthetic: Readonly<{
      issuer: string;
      publicKey: string;
      tenantPattern: RegExp;
    }>;
  }>;

function operationClaimEnvironment(
  environment: BizzbloxSocialEnvironment
): Readonly<{ issuer: string; publicKey: string }> {
  const prefix = environment.toUpperCase();
  return Object.freeze({
    issuer: requiredEnvironment(`BIZZBLOX_${prefix}_OPERATION_CLAIM_ISSUER`),
    publicKey: requiredEnvironment(
      `BIZZBLOX_${prefix}_OPERATION_CLAIM_PUBLIC_KEY_PEM`
    )
      .split('\\n')
      .join('\n'),
  });
}

function authConfig(): BizzbloxRuntimeAuthConfig {
  if (process.env.BIZZBLOX_SERVICE_MODE !== '1') {
    throw new Error(
      'BizzBLOX service module is unavailable outside service mode'
    );
  }
  const accountId = requiredEnvironment('BIZZBLOX_BRIDGE_ACCOUNT_ID');
  const bridgePrincipalArn = requiredEnvironment(
    'BIZZBLOX_BRIDGE_PRINCIPAL_ARN'
  );
  if (
    !/^[0-9]{12}$/.test(accountId) ||
    bridgePrincipalArn !== `arn:aws:iam::${accountId}:role/BizzbloxSocialBridge`
  ) {
    throw new Error('Invalid BizzBLOX bridge identity configuration');
  }
  const smokePublicKey = requiredEnvironment(
    'BIZZBLOX_SMOKE_OPERATION_CLAIM_PUBLIC_KEY_PEM'
  )
    .split('\\n')
    .join('\n');
  const smokeTenantPattern = requiredEnvironment(
    'BIZZBLOX_SMOKE_OPERATION_CLAIM_TENANT_PATTERN'
  );
  if (smokeTenantPattern !== '^tenant_synthetic_[A-Za-z0-9_-]{1,103}$') {
    throw new Error('Invalid BizzBLOX synthetic claim configuration');
  }
  return Object.freeze({
    accountId,
    audience: 'bizzblox-social',
    bridgePrincipalArn,
    clock: () => new Date(),
    environments: Object.freeze(
      Object.fromEntries(
        BIZZBLOX_SOCIAL_ENVIRONMENTS.map((environment) => [
          environment,
          operationClaimEnvironment(environment),
        ])
      ) as Record<
        BizzbloxSocialEnvironment,
        Readonly<{ issuer: string; publicKey: string }>
      >
    ),
    synthetic: Object.freeze({
      issuer: requiredEnvironment('BIZZBLOX_SMOKE_OPERATION_CLAIM_ISSUER'),
      publicKey: smokePublicKey,
      tenantPattern: new RegExp(smokeTenantPattern),
    }),
  });
}

function credentialCodec(): BizzbloxTenantCredentialCodec {
  const root = requiredEnvironment('APPLICATION_SECRET');
  if (root.length < 32) throw new Error('Invalid BizzBLOX application secret');
  const input = Buffer.from(root, 'utf8');
  const salt = Buffer.from('bizzblox-social-runtime-v1', 'utf8');
  return new BizzbloxTenantCredentialCodec({
    encryptionKey: Buffer.from(
      hkdfSync('sha256', input, salt, 'tenant-recovery-encryption', 32)
    ),
    hashKey: Buffer.from(
      hkdfSync('sha256', input, salt, 'tenant-credential-hash', 32)
    ),
    randomBytes,
  });
}

function opaqueRefs(): BizzbloxHmacOpaqueRefs {
  const input = Buffer.from(requiredEnvironment('APPLICATION_SECRET'), 'utf8');
  return new BizzbloxHmacOpaqueRefs(
    Buffer.from(
      hkdfSync(
        'sha256',
        input,
        Buffer.from('bizzblox-social-runtime-v1', 'utf8'),
        'channel-and-helper-opaque-references',
        32
      )
    )
  );
}

function connectionConfig(): BizzbloxConnectionConfig {
  return Object.freeze({
    ampReturnUrls: Object.freeze({
      dev: requiredEnvironment('BIZZBLOX_DEV_AMP_RETURN_URL'),
      preprod: requiredEnvironment('BIZZBLOX_PREPROD_AMP_RETURN_URL'),
      prod: requiredEnvironment('BIZZBLOX_PROD_AMP_RETURN_URL'),
    }),
    clock: () => new Date(),
    createOpaqueHandle: randomUUID,
    publicOrigin: 'https://social.bizzblox.com',
  });
}

function connectionStateCodec(): BizzbloxConnectionStateCodec {
  const input = Buffer.from(requiredEnvironment('APPLICATION_SECRET'), 'utf8');
  return new BizzbloxConnectionStateCodec({
    encryptionKey: Buffer.from(
      hkdfSync(
        'sha256',
        input,
        Buffer.from('bizzblox-social-runtime-v1', 'utf8'),
        'connection-state-encryption',
        32
      )
    ),
    randomBytes,
  });
}

@Module({
  controllers: [
    BizzbloxHealthController,
    BizzbloxController,
    BizzbloxConnectionsController,
    BizzbloxOAuthController,
    BizzbloxPublicationsController,
  ],
  providers: [
    BizzbloxAuthGuard,
    BizzbloxIamContextMiddleware,
    BizzbloxTenantService,
    BizzbloxContractService,
    BizzbloxConnectionsService,
    BizzbloxPublicationsService,
    PostizBizzbloxConnectionProviderGateway,
    PostizBizzbloxCustomFieldSealer,
    PrismaBizzbloxTenantStore,
    PrismaBizzbloxPublicationStore,
    PrismaBizzbloxMediaStore,
    PrismaBizzbloxChannelAccess,
    PrismaBizzbloxChannelDirectory,
    BizzbloxPostizClientFactory,
    PrismaBizzbloxTenantAccess,
    RedisBizzbloxReplayStore,
    RedisBizzbloxConnectionStateStore,
    BizzbloxRuntimeOrganizationFactory,
    { provide: BIZZBLOX_TENANT_DATABASE, useExisting: PrismaService },
    { provide: BIZZBLOX_CHANNEL_DATABASE, useExisting: PrismaService },
    { provide: BIZZBLOX_PUBLICATION_DATABASE, useExisting: PrismaService },
    { provide: BIZZBLOX_MEDIA_DATABASE, useExisting: PrismaService },
    { provide: BIZZBLOX_TENANT_STORE, useExisting: PrismaBizzbloxTenantStore },
    {
      provide: BIZZBLOX_PUBLICATION_STORE,
      useExisting: PrismaBizzbloxPublicationStore,
    },
    { provide: BIZZBLOX_MEDIA_STORE, useExisting: PrismaBizzbloxMediaStore },
    {
      provide: BIZZBLOX_CHANNEL_ACCESS,
      useExisting: PrismaBizzbloxChannelAccess,
    },
    {
      provide: BIZZBLOX_CHANNEL_DIRECTORY,
      useExisting: PrismaBizzbloxChannelDirectory,
    },
    { provide: BIZZBLOX_OPAQUE_REFS, useFactory: opaqueRefs },
    { provide: BIZZBLOX_CONNECTION_CONFIG, useFactory: connectionConfig },
    {
      provide: BIZZBLOX_CONNECTION_STATE_CODEC,
      useFactory: connectionStateCodec,
    },
    {
      provide: BIZZBLOX_CONNECTION_PROVIDERS,
      useExisting: PostizBizzbloxConnectionProviderGateway,
    },
    {
      provide: BIZZBLOX_CONNECTION_STATES,
      useExisting: RedisBizzbloxConnectionStateStore,
    },
    {
      provide: BIZZBLOX_CUSTOM_FIELD_SEALER,
      useExisting: PostizBizzbloxCustomFieldSealer,
    },
    {
      provide: BIZZBLOX_POSTIZ_CLIENTS,
      useExisting: BizzbloxPostizClientFactory,
    },
    { provide: BIZZBLOX_PUBLICATION_IDS, useValue: { randomId: randomUUID } },
    {
      provide: BIZZBLOX_TENANT_CREDENTIALS,
      useFactory: credentialCodec,
    },
    {
      provide: BIZZBLOX_ORGANIZATION_FACTORY,
      useExisting: BizzbloxRuntimeOrganizationFactory,
    },
    { provide: BIZZBLOX_REDIS, useValue: ioRedis },
    { provide: BIZZBLOX_REPLAY_STORE, useExisting: RedisBizzbloxReplayStore },
    {
      provide: BIZZBLOX_TENANT_ACCESS,
      useExisting: PrismaBizzbloxTenantAccess,
    },
    {
      provide: BIZZBLOX_AUTH_CONFIG,
      useFactory: () => {
        const {
          environments: _environments,
          synthetic: _synthetic,
          ...config
        } = authConfig();
        return config;
      },
    },
    {
      provide: BIZZBLOX_CLAIM_VERIFIER,
      useFactory: () => {
        const config = authConfig();
        return new BizzbloxJwtClaimVerifier({
          audience: config.audience,
          clock: config.clock,
          environments: config.environments,
          synthetic: config.synthetic,
        });
      },
    },
  ],
})
export class BizzbloxModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applyBizzbloxIamContext(consumer);
  }
}
