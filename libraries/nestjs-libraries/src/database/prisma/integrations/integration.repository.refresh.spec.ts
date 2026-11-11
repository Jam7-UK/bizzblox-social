import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IntegrationRepository } from './integration.repository';
import { IntegrationService } from './integration.service';
import { RefreshIntegrationService } from '../../../integrations/refresh.integration.service';
import { ProviderRefreshFailure } from '../../../integrations/social/social.integrations.interface';

const url = process.env.SOCIAL_OWNERSHIP_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== '127.0.0.1' ||
    new URL(url).pathname !== '/ownership')
) {
  throw new Error(
    'Refresh tests require the disposable local ownership database.'
  );
}

describe.skipIf(!url)('durable credential recovery in PostgreSQL', () => {
  let db: PrismaClient;
  let repository: IntegrationRepository;
  const secrets = new Map<string, string>();
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
        seal: async (ctx, value) => {
          const key = JSON.stringify(ctx) + randomUUID();
          secrets.set(key, value);
          return key;
        },
        open: async (_ctx, value) => {
          if (!secrets.has(value)) throw new Error('Envelope unavailable');
          return secrets.get(value)!;
        },
      },
      model
    );
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  const credentials = {
    accessToken: 'new-access-secret',
    refreshToken: 'new-refresh-secret',
    expiresIn: 3600,
    id: '',
    name: '',
    username: '',
  };
  async function fixture(
    options: { oneTimeToken?: boolean; refreshReplaySafe?: boolean } = {}
  ) {
    const org = (
      await db.organization.create({ data: { name: 'Refresh test' } })
    ).id;
    const provider = {
      identifier: randomUUID(),
      refreshToken: vi.fn().mockResolvedValue(credentials),
      ...options,
    };
    const manager = { getSocialIntegration: () => provider };
    const service = new RefreshIntegrationService(
      manager as never,
      repository,
      {} as never
    );
    const connect = (id = 'account', oneTime = false) =>
      repository.createOrUpdateIntegration(
        undefined,
        oneTime,
        org,
        'Account',
        undefined,
        'social',
        id,
        provider.identifier,
        'old-access-secret',
        'old-refresh-secret',
        1
      );
    const row = await connect();
    await db.integration.update({
      where: { id: row.id },
      data: { tokenExpiration: new Date(0) },
    });
    const read = () =>
      db.integration.findUniqueOrThrow({ where: { id: row.id } });
    return { org, provider, service, connect, row, read, manager };
  }
  function deferred() {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('admits one exchange across activity and bulk paths and settles sealed credentials', async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    f.provider.refreshToken.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return credentials;
    });
    const first = f.service.run(f.org, f.row.id);
    await started.promise;
    await f.service.run(f.org, f.row.id, true);
    const bulk = new IntegrationService(
      { refreshCandidates: async () => [f.row] } as never,
      {} as never,
      f.manager as never,
      {} as never,
      f.service,
      {} as never
    );
    await bulk.refreshTokens();
    expect(f.provider.refreshToken).toHaveBeenCalledTimes(1);
    release.resolve();
    await first;
    const stored = await f.read();
    expect(stored).toMatchObject({
      healthState: 'ready',
      credentialGeneration: 1,
      refreshClaim: null,
      refreshPendingAccess: null,
    });
    expect(JSON.stringify(stored)).not.toContain('new-access-secret');
    await expect(
      repository.openForProviderExecution(stored)
    ).resolves.toMatchObject({ token: credentials.accessToken });
  });

  it.each([false, true])(
    'recovers an expired exchange lease only with persisted replay proof: %s',
    async (safe) => {
      const f = await fixture({ refreshReplaySafe: safe });
      const claim = (await repository.claimRefresh(
        f.org,
        f.row.id,
        false,
        false
      ))!;
      await repository.beginRefreshExchange(claim, safe);
      await db.integration.update({
        where: { id: f.row.id },
        data: { refreshLeaseUntil: new Date(0) },
      });
      await f.service.run(f.org, f.row.id);
      expect((await f.read()).healthState).toBe(
        safe ? 'recovering' : 'operator_required'
      );
      await expect(
        repository.stageRefreshCredentials(claim, credentials)
      ).rejects.toThrow('stale');
      await db.integration.update({
        where: { id: f.row.id },
        data: { refreshNextAt: new Date(0) },
      });
      await f.service.run(f.org, f.row.id);
      expect(f.provider.refreshToken).toHaveBeenCalledTimes(safe ? 1 : 0);
    }
  );

  it.each(['reconnect', 'disable', 'delete', 'migrate'] as const)(
    'fences a late exchange after %s',
    async (action) => {
      const f = await fixture();
      const started = deferred();
      const release = deferred();
      f.provider.refreshToken.mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return credentials;
      });
      const pending = f.service.run(f.org, f.row.id);
      await started.promise;
      if (action === 'reconnect') await f.connect();
      if (action === 'disable')
        await repository.disableChannel(f.org, f.row.id);
      if (action === 'delete') await repository.deleteChannel(f.org, f.row.id);
      if (action === 'migrate')
        await repository.migrateIntegration(
          f.org,
          f.row.id,
          'new-account',
          randomUUID(),
          'new-account'
        );
      const before = await f.read();
      release.resolve();
      await pending;
      expect(await f.read()).toEqual(before);
      await expect(repository.openForProviderExecution(f.row)).rejects.toThrow(
        'unavailable'
      );
    }
  );

  it('retries profile reads using durable exchanged credentials without another token exchange', async () => {
    const f = await fixture();
    await db.integration.update({
      where: { id: f.row.id },
      data: { rootInternalId: 'parent-account' },
    });
    const reConnect = vi
      .fn()
      .mockRejectedValueOnce(new Error('raw profile error with secret'))
      .mockResolvedValue({ id: 'account', accessToken: 'page-access' });
    Object.assign(f.provider, { reConnect });
    await f.service.run(f.org, f.row.id);
    const held = await f.read();
    expect(held).toMatchObject({
      healthState: 'recovering',
      refreshReason: 'profile_read',
      refreshPhase: 'resolving',
    });
    expect(held.refreshPendingAccess).toBeTruthy();
    expect(JSON.stringify(held)).not.toContain('raw profile');
    await db.integration.update({
      where: { id: f.row.id },
      data: { refreshNextAt: new Date(0) },
    });
    await f.service.run(f.org, f.row.id);
    expect(f.provider.refreshToken).toHaveBeenCalledTimes(1);
    expect(reConnect).toHaveBeenLastCalledWith(
      'parent-account',
      'account',
      'new-access-secret'
    );
    expect((await f.read()).healthState).toBe('ready');
  });

  it('serializes one-time sibling claims and invalidates every sibling on reconnect without enabling it', async () => {
    const f = await fixture({ oneTimeToken: true });
    const sibling = await f.connect('page');
    await db.integration.update({
      where: { id: sibling.id },
      data: { rootInternalId: 'account', disabled: true },
    });
    const claim = (await repository.claimRefresh(
      f.org,
      f.row.id,
      true,
      false
    ))!;
    expect(claim.rows).toHaveLength(2);
    await repository.beginRefreshExchange(claim, false);
    await f.connect('account', true);
    await expect(
      repository.stageRefreshCredentials(claim, credentials)
    ).rejects.toThrow('stale');
    const rows = await db.integration.findMany({
      where: { organizationId: f.org },
    });
    expect(
      rows.every(
        (row) => row.refreshClaim === null && row.credentialGeneration === 1
      )
    ).toBe(true);
    expect(rows.find((row) => row.id === sibling.id)?.disabled).toBe(true);
  });

  it('holds ambiguous failures and legacy flags without emitting consent or raw errors', async () => {
    const f = await fixture();
    f.provider.refreshToken.mockRejectedValue(
      new Error('invalid_grant generic 401 access-secret')
    );
    await f.service.run(f.org, f.row.id);
    expect(await f.read()).toMatchObject({
      healthState: 'operator_required',
      refreshReason: 'exchange_uncertain',
    });
    expect(JSON.stringify(await f.read())).not.toContain('generic 401');
    const legacy = await f.connect('legacy');
    await db.integration.update({
      where: { id: legacy.id },
      data: { refreshNeeded: true, tokenExpiration: new Date(0) },
    });
    await f.service.run(f.org, legacy.id);
    expect(f.provider.refreshToken).toHaveBeenCalledTimes(1);
    const legacyRow = await db.integration.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    expect(repository.health(legacyRow).state).toBe('operator_required');
    expect(
      (await repository.refreshCandidates(undefined, true)).some(
        (row) => row.id === legacy.id
      )
    ).toBe(true);
    await expect(
      repository.openForProviderExecution(legacyRow)
    ).rejects.toThrow('unavailable');
  });

  it('keeps safe retries durable without an attempt ceiling and lets bulk continue past a broken item', async () => {
    const f = await fixture({ refreshReplaySafe: true });
    await db.integration.update({
      where: { id: f.row.id },
      data: { refreshAttempts: 16 },
    });
    f.provider.refreshToken
      .mockRejectedValueOnce(new ProviderRefreshFailure('retry'))
      .mockResolvedValue(credentials);
    await f.service.run(f.org, f.row.id);
    expect(await f.read()).toMatchObject({
      healthState: 'recovering',
      refreshAttempts: 16,
    });
    await db.integration.update({
      where: { id: f.row.id },
      data: { refreshNextAt: new Date(0) },
    });
    await f.service.run(f.org, f.row.id);
    expect((await f.read()).healthState).toBe('ready');
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('local infrastructure failure'))
      .mockResolvedValue(undefined);
    const rows = [
      { id: 'a', organizationId: f.org },
      { id: 'b', organizationId: f.org },
    ];
    const bulk = new IntegrationService(
      { refreshCandidates: async () => rows } as never,
      {} as never,
      {} as never,
      {} as never,
      { run } as never,
      {} as never
    );
    await bulk.refreshTokens();
    expect(run.mock.calls.map((call) => call[1])).toEqual(['a', 'b']);
  });
  it('offers fenced configuration repair without rearming unknown consumption or stale evidence', async () => {
    const f = await fixture({ refreshReplaySafe: true });
    f.provider.refreshToken.mockRejectedValueOnce(
      new ProviderRefreshFailure('configuration')
    );
    await f.service.run(f.org, f.row.id);
    const held = await f.read();
    expect(
      await f.service.retryConfiguration(
        f.org,
        f.row.id,
        held.credentialGeneration,
        held.healthRevision - 1
      )
    ).toBe(false);
    expect(
      await f.service.retryConfiguration(
        f.org,
        f.row.id,
        held.credentialGeneration,
        held.healthRevision
      )
    ).toBe(true);
    await f.service.run(f.org, f.row.id);
    expect((await f.read()).healthState).toBe('ready');
    const unknown = await fixture();
    unknown.provider.refreshToken.mockRejectedValue(new Error('timeout'));
    await unknown.service.run(unknown.org, unknown.row.id);
    const uncertain = await unknown.read();
    expect(
      await unknown.service.retryConfiguration(
        unknown.org,
        unknown.row.id,
        uncertain.credentialGeneration,
        uncertain.healthRevision
      )
    ).toBe(false);
  });

  it('retains existing disabled/deleted channels and monotonically advances health on a fresh connection', async () => {
    const f = await fixture();
    const before = await f.read();
    await repository.disableChannel(f.org, f.row.id);
    await f.service.run(f.org, f.row.id, true);
    expect(f.provider.refreshToken).not.toHaveBeenCalled();
    await f.connect();
    expect((await f.read()).disabled).toBe(true);
    expect((await f.read()).healthRevision).toBeGreaterThan(
      before.healthRevision
    );
    await repository.deleteChannel(f.org, f.row.id);
    expect(await repository.getIntegrationsList(f.org)).toEqual([]);
    await f.service.run(f.org, f.row.id, true);
    expect(f.provider.refreshToken).not.toHaveBeenCalled();
  });
  it('uses the saved rotated refresh token when profile recovery outlives its pending access token', async () => {
    const f = await fixture();
    await db.integration.update({
      where: { id: f.row.id },
      data: { rootInternalId: 'parent' },
    });
    const reConnect = vi
      .fn()
      .mockRejectedValueOnce(new Error('profile unavailable'))
      .mockResolvedValue({ id: 'account', accessToken: 'page' });
    Object.assign(f.provider, { reConnect });
    await f.service.run(f.org, f.row.id);
    await db.integration.update({
      where: { id: f.row.id },
      data: { refreshPendingExpiry: new Date(0), refreshNextAt: new Date(0) },
    });
    await f.service.run(f.org, f.row.id);
    expect(f.provider.refreshToken).toHaveBeenCalledTimes(1);
    expect(await f.read()).toMatchObject({
      healthState: 'recovering',
      refreshPendingAccess: null,
    });
    await db.integration.update({
      where: { id: f.row.id },
      data: { refreshNextAt: new Date(0) },
    });
    await f.service.run(f.org, f.row.id);
    expect(f.provider.refreshToken.mock.calls[1][0]).toBe('new-refresh-secret');
    expect((await f.read()).healthState).toBe('ready');
  });
  it('keeps disabled siblings supplied without blocking subsequent refreshes or enabling them', async () => {
    const f = await fixture({ oneTimeToken: true });
    const sibling = await f.connect('page');
    await db.integration.update({
      where: { id: sibling.id },
      data: { rootInternalId: 'account', disabled: true },
    });
    await f.service.run(f.org, f.row.id);
    await db.integration.update({
      where: { id: f.row.id },
      data: { tokenExpiration: new Date(0) },
    });
    await f.service.run(f.org, f.row.id);
    expect(f.provider.refreshToken).toHaveBeenCalledTimes(2);
    expect(
      await db.integration.findUniqueOrThrow({ where: { id: sibling.id } })
    ).toMatchObject({
      disabled: true,
      healthState: 'recovering',
      refreshPhase: 'resolving',
    });
    await repository.enableChannel(f.org, sibling.id);
    await f.service.run(f.org, sibling.id);
    expect(f.provider.refreshToken).toHaveBeenCalledTimes(2);
    expect(
      await db.integration.findUniqueOrThrow({ where: { id: sibling.id } })
    ).toMatchObject({ disabled: false, healthState: 'ready' });
  });
  it('recovers a pre-exchange envelope failure without invoking or consuming the provider token', async () => {
    const f = await fixture();
    const opening = vi
      .spyOn(repository, 'openForRefresh')
      .mockRejectedValueOnce(new Error('envelope unavailable'));
    await f.service.run(f.org, f.row.id);
    expect(f.provider.refreshToken).not.toHaveBeenCalled();
    expect(await f.read()).toMatchObject({
      healthState: 'recovering',
      refreshPhase: 'prepared',
    });
    opening.mockRestore();
    await db.integration.update({
      where: { id: f.row.id },
      data: { refreshNextAt: new Date(0) },
    });
    await f.service.run(f.org, f.row.id);
    expect(f.provider.refreshToken).toHaveBeenCalledTimes(1);
    expect((await f.read()).healthState).toBe('ready');
  });

  it('binds affirmative consent evidence to its claimed generation and preserves it until fresh authorization', async () => {
    const f = await fixture();
    f.provider.refreshToken.mockRejectedValue(
      new ProviderRefreshFailure('consent')
    );
    await f.service.run(f.org, f.row.id);
    const held = await f.read();
    expect(held).toMatchObject({
      healthState: 'consent_required',
      refreshReason: 'refresh_invalid_grant',
      credentialGeneration: 0,
    });
    await f.service.run(f.org, f.row.id, true);
    expect(f.provider.refreshToken).toHaveBeenCalledTimes(1);
    await f.connect();
    const fresh = await f.read();
    expect(fresh.healthRevision).toBeGreaterThan(held.healthRevision);
    expect(fresh).toMatchObject({
      healthState: 'ready',
      credentialGeneration: 1,
    });
  });
});
