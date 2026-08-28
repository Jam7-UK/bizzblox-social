import { describe, expect, it, vi } from 'vitest';

import { IntegrationRepository } from './integration.repository';

describe('managed integration token persistence', () => {
  it('seals both provider tokens against the stable integration row before upsert', async () => {
    const integrationModel = {
      integration: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockImplementation(async ({ create }) => create),
      },
    };
    const sealedContexts: Array<Readonly<Record<string, string>>> = [];
    const tokens = {
      open: vi.fn(),
      seal: vi.fn().mockImplementation(async (context) => {
        sealedContexts.push(context);
        return `sealed:${context.purpose}`;
      }),
    };
    const unused = {} as never;
    const repository = new IntegrationRepository(
      { model: integrationModel } as never,
      unused,
      unused,
      unused,
      unused,
      unused,
      tokens
    );

    const stored = await repository.createOrUpdateIntegration(
      undefined,
      false,
      'organization_123',
      'Channel',
      undefined,
      'social',
      'provider-account-456',
      'linkedin',
      'access-secret',
      'refresh-secret'
    );

    expect(stored).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      token: 'sealed:access',
      refreshToken: 'sealed:refresh',
    });
    expect(sealedContexts).toEqual([
      {
        integrationId: stored.id,
        organizationId: 'organization_123',
        purpose: 'access',
      },
      {
        integrationId: stored.id,
        organizationId: 'organization_123',
        purpose: 'refresh',
      },
    ]);
    expect(tokens.seal).toHaveBeenNthCalledWith(
      1,
      sealedContexts[0],
      'access-secret'
    );
    expect(tokens.seal).toHaveBeenNthCalledWith(
      2,
      sealedContexts[1],
      'refresh-secret'
    );
    expect(
      JSON.stringify(integrationModel.integration.upsert.mock.calls)
    ).not.toContain('access-secret');
    expect(
      JSON.stringify(integrationModel.integration.upsert.mock.calls)
    ).not.toContain('refresh-secret');
  });

  it('seals one-time provider tokens independently for every sibling row', async () => {
    const integrationModel = {
      integration: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ rootInternalId: 'root-account' }),
        findMany: vi.fn().mockResolvedValue([
          { id: 'integration_sibling_1', organizationId: 'organization_123' },
          { id: 'integration_sibling_2', organizationId: 'organization_123' },
        ]),
        findUnique: vi.fn().mockResolvedValue({ id: 'integration_current' }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        upsert: vi.fn().mockResolvedValue({ id: 'integration_current' }),
      },
    };
    const tokens = {
      open: vi.fn(),
      seal: vi
        .fn()
        .mockImplementation(
          async (context) =>
            `sealed:${context.integrationId}:${context.purpose}`
        ),
    };
    const unused = {} as never;
    const repository = new IntegrationRepository(
      { model: integrationModel } as never,
      unused,
      unused,
      unused,
      unused,
      unused,
      tokens
    );

    await repository.createOrUpdateIntegration(
      undefined,
      true,
      'organization_123',
      'Channel',
      undefined,
      'social',
      'provider-account-456',
      'linkedin',
      'access-secret',
      'refresh-secret'
    );

    expect(integrationModel.integration.updateMany).not.toHaveBeenCalled();
    expect(integrationModel.integration.update.mock.calls).toEqual([
      [
        {
          where: { id: 'integration_sibling_1' },
          data: expect.objectContaining({
            token: 'sealed:integration_sibling_1:access',
            refreshToken: 'sealed:integration_sibling_1:refresh',
          }),
        },
      ],
      [
        {
          where: { id: 'integration_sibling_2' },
          data: expect.objectContaining({
            token: 'sealed:integration_sibling_2:access',
            refreshToken: 'sealed:integration_sibling_2:refresh',
          }),
        },
      ],
    ]);
    expect(
      JSON.stringify(integrationModel.integration.update.mock.calls)
    ).not.toContain('access-secret');
    expect(
      JSON.stringify(integrationModel.integration.update.mock.calls)
    ).not.toContain('refresh-secret');
  });

  it('seals provider tokens written during account selection', async () => {
    const integrationModel = {
      integration: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockImplementation(async ({ data }) => data),
      },
    };
    const tokens = {
      open: vi.fn(),
      seal: vi
        .fn()
        .mockImplementation(
          async (context) =>
            `sealed:${context.integrationId}:${context.purpose}`
        ),
    };
    const unused = {} as never;
    const repository = new IntegrationRepository(
      { model: integrationModel } as never,
      unused,
      unused,
      unused,
      unused,
      unused,
      tokens
    );

    await repository.updateIntegration('integration_current', {
      internalId: 'selected-provider-account',
      organizationId: 'organization_123',
      refreshToken: 'refresh-secret',
      token: 'access-secret',
    });

    expect(integrationModel.integration.update).toHaveBeenCalledWith({
      where: { id: 'integration_current' },
      data: expect.objectContaining({
        token: 'sealed:integration_current:access',
        refreshToken: 'sealed:integration_current:refresh',
      }),
    });
    expect(
      JSON.stringify(integrationModel.integration.update.mock.calls)
    ).not.toContain('access-secret');
    expect(
      JSON.stringify(integrationModel.integration.update.mock.calls)
    ).not.toContain('refresh-secret');
  });

  it('opens a cloned integration only through the explicit provider execution seam', async () => {
    const tokens = {
      open: vi
        .fn()
        .mockImplementation(
          async (context, value) =>
            `open:${context.integrationId}:${context.purpose}:${value}`
        ),
      seal: vi.fn(),
    };
    const unused = {} as never;
    const repository = new IntegrationRepository(
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      tokens
    );
    const stored = {
      id: 'integration_current',
      organizationId: 'organization_123',
      refreshToken: 'sealed-refresh',
      token: 'sealed-access',
    };

    const opened = await repository.openForProviderExecution(stored as never);

    expect(opened).toMatchObject({
      refreshToken: 'open:integration_current:refresh:sealed-refresh',
      token: 'open:integration_current:access:sealed-access',
    });
    expect(opened).not.toBe(stored);
    expect(stored).toEqual({
      id: 'integration_current',
      organizationId: 'organization_123',
      refreshToken: 'sealed-refresh',
      token: 'sealed-access',
    });
    expect(tokens.open).toHaveBeenNthCalledWith(
      1,
      {
        integrationId: 'integration_current',
        organizationId: 'organization_123',
        purpose: 'access',
      },
      'sealed-access'
    );
    expect(tokens.open).toHaveBeenNthCalledWith(
      2,
      {
        integrationId: 'integration_current',
        organizationId: 'organization_123',
        purpose: 'refresh',
      },
      'sealed-refresh'
    );
  });
});
