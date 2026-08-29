import { Inject, Injectable } from '@nestjs/common';

import type {
  BizzbloxMediaRecord,
  BizzbloxMediaStore,
} from './bizzblox-publications.service';

export const BIZZBLOX_MEDIA_DATABASE = Symbol('BIZZBLOX_MEDIA_DATABASE');

export interface BizzbloxMediaDatabase {
  bizzbloxMediaUpload: Readonly<{
    create(input: { data: BizzbloxMediaRecord }): Promise<BizzbloxMediaRecord>;
    findMany(input: {
      where: {
        organizationId: string;
        externalMediaId: { in: readonly string[] };
      };
    }): Promise<readonly BizzbloxMediaRecord[]>;
    findUnique(input: {
      where: {
        organizationId_externalMediaId: {
          organizationId: string;
          externalMediaId: string;
        };
      };
    }): Promise<BizzbloxMediaRecord | null>;
  }>;
}

function uniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class PrismaBizzbloxMediaStore implements BizzbloxMediaStore {
  constructor(
    @Inject(BIZZBLOX_MEDIA_DATABASE)
    private readonly database: BizzbloxMediaDatabase
  ) {}

  async reserve(candidate: BizzbloxMediaRecord) {
    try {
      return Object.freeze({
        outcome: 'created' as const,
        record: await this.database.bizzbloxMediaUpload.create({
          data: candidate,
        }),
      });
    } catch (error) {
      if (!uniqueConstraint(error)) throw error;
      const existing = await this.database.bizzbloxMediaUpload.findUnique({
        where: {
          organizationId_externalMediaId: {
            organizationId: candidate.organizationId,
            externalMediaId: candidate.externalMediaId,
          },
        },
      });
      if (!existing) throw error;
      return Object.freeze({
        outcome:
          existing.checksumSha256 === candidate.checksumSha256
            ? ('existing' as const)
            : ('conflict' as const),
        record: existing,
      });
    }
  }

  async resolve(organizationId: string, mediaHandles: readonly string[]) {
    if (mediaHandles.length === 0) return Object.freeze([]);
    return Object.freeze(
      await this.database.bizzbloxMediaUpload.findMany({
        where: {
          organizationId,
          externalMediaId: { in: mediaHandles },
        },
      })
    );
  }
}
