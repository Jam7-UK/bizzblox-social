import 'reflect-metadata';

import { PATH_METADATA } from '@nestjs/common/constants';
import { type MiddlewareConsumer, Module, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BizzbloxAuthGuard } from './bizzblox-auth.guard';
import { BizzbloxContractService } from './bizzblox-contract.service';
import { BizzbloxConnectionsController } from './bizzblox-connections.controller';
import { BizzbloxConnectionsService } from './bizzblox-connections.service';
import {
  applyBizzbloxIamContext,
  BizzbloxIamContextMiddleware,
} from './bizzblox-iam.middleware';
import { BizzbloxPublicationsController } from './bizzblox-publications.controller';
import { BizzbloxController } from './bizzblox.controller';

/**
 * Express 5 (path-to-regexp v8) reads an unescaped `:name` inside a segment as a
 * path parameter, so `/connections:begin` also matches `/connections:outcome`.
 * Every custom-method route must therefore escape its colon (`\\:`). The first
 * test proves that at the decorator level for all three controllers; the second
 * dispatches real HTTP requests through a Nest application so the routing that
 * production uses is what is asserted, not the decorator string alone. The app
 * also wires the IAM context middleware exactly as the production module does:
 * Nest's overlapped-route check turns `forRoutes(Controller)` into a regular
 * expression per route and broke on the escaped colon (startup crash,
 * 2026-09-03), so a path-scoped selector is the only shape allowed here.
 */

const CONTROLLERS = [
  BizzbloxController,
  BizzbloxConnectionsController,
  BizzbloxPublicationsController,
];

// Operation the fake guard grants per custom-method path, mirroring what the
// real claim would carry; the controller rejects a mismatch with 401.
const OPERATIONS: Record<string, string> = {
  'connections:begin': 'connection.begin',
  'connections:select': 'connection.select',
  'connections:outcome': 'connection.outcome.redeem',
  'connections:disconnect': 'connection.disconnect',
  'connections:reconnect': 'connection.reconnect',
};

function routePaths(controller: object & { prototype: object }): string[] {
  return Object.getOwnPropertyNames(controller.prototype)
    .map((name) =>
      Reflect.getMetadata(PATH_METADATA, controller.prototype[name as never])
    )
    .filter((path): path is string => typeof path === 'string');
}

describe('BizzBLOX custom-method routes', () => {
  it('escapes every colon that follows a literal segment, on all three controllers', () => {
    const paths = CONTROLLERS.flatMap(routePaths);
    const customMethods = paths.filter((path) => /[a-z]\\?:[a-z]/.test(path));
    expect(customMethods.length).toBe(8);
    for (const path of customMethods) {
      expect(path, `${path} must escape its colon for Express 5`).toMatch(
        /[a-z]\\:[a-z]/
      );
    }
    // Real path parameters keep their unescaped colon.
    expect(paths).toContain('/tenants/:tenantHandle');
    expect(paths).toContain('/channels/:channelHandle/contract');
  });

  describe('dispatch through a real Nest application', () => {
    const connections = {
      begin: vi
        .fn()
        .mockResolvedValue({
          mode: 'redirect',
          authorizationUrl: 'https://x.test',
          expiresAt: 1,
        }),
      select: vi.fn().mockResolvedValue({ outcome: 'failed' }),
      redeemOutcome: vi.fn().mockResolvedValue({ outcome: 'failed' }),
      disconnect: vi.fn().mockResolvedValue({ outcome: 'disconnected' }),
      reconnect: vi
        .fn()
        .mockResolvedValue({
          mode: 'redirect',
          authorizationUrl: 'https://x.test',
          expiresAt: 1,
        }),
    };
    const seenIam: unknown[] = [];
    let baseUrl = '';
    let close: () => Promise<void> = async () => {};

    // Mirrors BizzbloxModule.configure so middleware registration runs for real.
    @Module({
      controllers: [BizzbloxConnectionsController],
      providers: [
        { provide: BizzbloxContractService, useValue: {} },
        { provide: BizzbloxConnectionsService, useValue: connections },
        BizzbloxIamContextMiddleware,
      ],
    })
    class RouteSpecModule {
      configure(consumer: MiddlewareConsumer): void {
        applyBizzbloxIamContext(consumer);
      }
    }

    beforeAll(async () => {
      // Vitest transpiles with esbuild, which emits decorators but not
      // `design:paramtypes`; give Nest the constructor types it needs for DI.
      Reflect.defineMetadata(
        'design:paramtypes',
        [BizzbloxContractService, BizzbloxConnectionsService],
        BizzbloxConnectionsController
      );
      const moduleRef = await Test.createTestingModule({
        imports: [RouteSpecModule],
      })
        .overrideGuard(BizzbloxAuthGuard)
        .useValue({
          canActivate: (context: {
            switchToHttp: () => { getRequest: () => Record<string, unknown> };
          }) => {
            const request = context.switchToHttp().getRequest();
            seenIam.push(request.bizzbloxIam);
            const suffix = String(request.originalUrl).split('/').pop() ?? '';
            request.bizzbloxAuth = {
              organizationId: 'postiz-org-1',
              connectorRevision: 7,
              environment: 'dev',
              credentialVersion: null,
              operation: OPERATIONS[suffix] ?? 'unknown',
            };
            return true;
          },
        })
        .compile();
      const app = moduleRef.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true }));
      await app.init();
      const server = app.getHttpServer() as import('node:http').Server;
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      baseUrl = `http://127.0.0.1:${address.port}/internal/bizzblox/v1`;
      close = async () => {
        await app.close();
      };
    });

    afterAll(async () => {
      await close();
    });

    async function post(path: string, body: unknown) {
      const response = await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bizzblox-iam-account': '123456789012',
          'x-bizzblox-iam-principal': 'arn:aws:iam::123456789012:role/BizzbloxSocialBridge',
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }

    it('routes each connections:* custom method to its own handler', async () => {
      const outcome = await post('connections:outcome', {
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
        outcomeHandle: 'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
      });
      expect(outcome).toEqual({ status: 201, body: { outcome: 'failed' } });
      // The IAM context middleware ran for the custom-method route.
      expect(seenIam.at(-1)).toEqual({
        accountId: '123456789012',
        principalArn: 'arn:aws:iam::123456789012:role/BizzbloxSocialBridge',
      });
      expect(connections.redeemOutcome).toHaveBeenCalledWith(
        'postiz-org-1',
        7,
        'dev',
        expect.objectContaining({
          outcomeHandle: 'outcome_opaque_abcdefghijklmnopqrstuvwxyz123456',
        })
      );
      expect(connections.begin).not.toHaveBeenCalled();

      await post('connections:begin', {
        provider: 'x',
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
      });
      expect(connections.begin).toHaveBeenCalledOnce();

      await post('connections:disconnect', {
        channelHandle: 'bbx_ch_exact_x_1234',
      });
      expect(connections.disconnect).toHaveBeenCalledOnce();

      await post('connections:reconnect', {
        channelHandle: 'bbx_ch_exact_x_1234',
      });
      expect(connections.reconnect).toHaveBeenCalledOnce();

      await post('connections:select', {
        attemptHandle: 'attempt_opaque_abcdefghijklmnopqrstuvwxyz1234',
        optionRef: 'option_opaque_abcdefghijklmnopqrstuvwxyz12345',
        userBinding: 'user_binding_exact_abcdefghijklmnopqrstuvwxyz',
      });
      expect(connections.select).toHaveBeenCalledOnce();
      expect(connections.begin).toHaveBeenCalledOnce();
    });
  });
});
