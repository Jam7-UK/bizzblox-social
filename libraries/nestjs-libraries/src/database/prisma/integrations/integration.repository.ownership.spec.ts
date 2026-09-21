import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationRepository } from './integration.repository';

// Only a disposable PostgreSQL database may be supplied; normal unit runs skip it.
const url = process.env.SOCIAL_OWNERSHIP_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.pathname !== '/ownership') {
    throw new Error(
      'Ownership tests require a disposable local ownership database.'
    );
  }
}
describe.skipIf(!url)('provider account ownership in PostgreSQL', () => {
  let db: PrismaClient;
  let repository: IntegrationRepository;
  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url } } });
    const model = { model: db } as never;
    repository = new IntegrationRepository(
      model,
      model,
      model,
      model,
      model,
      model,
      {
        open: async (_context, value) => value,
        seal: async (context, value) =>
          `sealed:${context.integrationId}:${value}`,
      },
      model
    );
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  const organization = async () =>
    (await db.organization.create({ data: { name: 'Ownership test' } })).id;
  const connect = (org: string, account: string, provider = 'provider-a') =>
    repository.createOrUpdateIntegration(
      undefined,
      false,
      org,
      'Same display label',
      undefined,
      'social',
      account,
      provider,
      'local-test-token'
    );

  it('admits exactly one concurrent owner and permits that owner to reconnect', async () => {
    const orgs = await Promise.all([organization(), organization()]);
    const account = randomUUID();
    const results = await Promise.allSettled(
      orgs.map((org) => connect(org, account))
    );
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    const rows = await db.integration.findMany({
      where: { internalId: account },
    });
    expect(rows).toHaveLength(1);
    const reconnected = await connect(rows[0].organizationId, account);
    expect(reconnected.id).toBe(rows[0].id);
    const migrated = await repository.migrateIntegration(
      rows[0].organizationId,
      rows[0].id,
      account,
      'provider-b',
      account
    );
    expect(migrated.id).toBe(rows[0].id);
    await expect(
      repository.openForProviderExecution(migrated)
    ).resolves.toMatchObject({ id: rows[0].id });
  });

  it('keeps equal external IDs in different provider namespaces separate', async () => {
    const org = await organization();
    const account = randomUUID();
    const first = await connect(org, account, 'provider-a');
    const second = await connect(org, account, 'provider-b');
    expect(second.id).not.toBe(first.id);
    expect(
      await db.integration.count({
        where: { organizationId: org, internalId: account },
      })
    ).toBe(2);
  });

  it('refuses existing duplicate ownership without deleting either connection', async () => {
    const orgs = await Promise.all([organization(), organization()]);
    const account = randomUUID();
    await db.integration.createMany({
      data: orgs.map((organizationId) => ({
        organizationId,
        internalId: account,
        providerIdentifier: 'provider-a',
        type: 'social',
        name: 'Existing connection',
        token: 'retained-token',
      })),
    });
    await expect(connect(orgs[0], account)).rejects.toThrow(
      /another workspace or environment/
    );
    const rows = await db.integration.findMany({
      where: { internalId: account },
    });
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.token === 'retained-token' && row.deletedAt === null
      )
    ).toBe(true);
    for (const row of rows) {
      await expect(repository.openForProviderExecution(row)).rejects.toThrow(
        /another workspace or environment/
      );
      await expect(
        repository.migrateIntegration(
          row.organizationId,
          row.id,
          randomUUID(),
          'provider-b',
          randomUUID()
        )
      ).rejects.toThrow(/another workspace or environment/);
    }
  });

  it('allows the same consent login to select different final accounts in different tenants', async () => {
    const orgs = await Promise.all([organization(), organization()]);
    const login = randomUUID();
    const pending = await Promise.all(
      orgs.map((org) =>
        repository.createOrUpdateIntegration(
          undefined,
          false,
          org,
          'Consent login',
          undefined,
          'social',
          login,
          'provider-pages',
          'consent-token',
          '',
          undefined,
          undefined,
          true
        )
      )
    );
    for (const [index, row] of pending.entries()) {
      await expect(
        repository.openForProviderExecution(row)
      ).resolves.toMatchObject({ id: row.id });
      if (index === 1) {
        await expect(
          repository.updateIntegration(row.id, {
            organizationId: row.organizationId,
            internalId: login,
            inBetweenSteps: false,
            token: 'must-not-be-written',
          })
        ).rejects.toThrow(/another workspace or environment/);
      }
      await repository.updateIntegration(row.id, {
        organizationId: row.organizationId,
        internalId: index === 0 ? login : randomUUID(),
        inBetweenSteps: false,
        token: 'page-token',
      });
    }
    expect(
      await db.integration.count({
        where: { organizationId: { in: orgs }, inBetweenSteps: false },
      })
    ).toBe(2);
  });

  it('fences account selection and provider migration before changing credentials or identity', async () => {
    const [owner, other] = await Promise.all([organization(), organization()]);
    const account = randomUUID();
    await connect(owner, account);
    const current = await connect(other, randomUUID());
    await expect(
      repository.updateIntegration(current.id, {
        organizationId: other,
        internalId: account,
        providerIdentifier: 'provider-a',
        token: 'replacement',
      })
    ).rejects.toThrow(/another workspace or environment/);
    await expect(
      repository.migrateIntegration(
        other,
        current.id,
        account,
        'provider-a',
        account
      )
    ).rejects.toThrow(/another workspace or environment/);
    expect(
      await db.integration.findUnique({ where: { id: current.id } })
    ).toMatchObject({
      internalId: current.internalId,
      token: current.token,
      deletedAt: null,
    });
  });
});
