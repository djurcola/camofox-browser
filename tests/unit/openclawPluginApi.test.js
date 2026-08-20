import { jest } from '@jest/globals';

/**
 * Regression coverage for the OpenClaw plugin registration surface.
 *
 * OpenClaw removed the legacy registerHealthCheck/registerRpc plugin methods.
 * Keep the plugin's gateway health/status methods on the supported
 * registerGatewayMethod API so ClawHub validation catches regressions locally.
 */

describe('OpenClaw plugin gateway registrations', () => {
  test('registers health and status through the current gateway API', async () => {
    const { default: registerPlugin } = await import('../../plugin.js');
    const gatewayMethods = [];
    const api = {
      config: {},
      pluginConfig: {
        autoStart: false,
        url: 'http://127.0.0.1:9377',
      },
      log: {
        info: jest.fn(),
        error: jest.fn(),
      },
      registerTool: jest.fn(),
      registerCommand: jest.fn(),
      registerCli: jest.fn(),
      registerGatewayMethod(name, handler, options) {
        gatewayMethods.push({ name, handler, options });
      },
    };

    await registerPlugin(api);

    expect(gatewayMethods.map(({ name }) => name)).toEqual([
      'camofox.health',
      'camofox.status',
    ]);
    expect(gatewayMethods.every(({ options }) => options?.scope === 'operator.read')).toBe(true);
  });
});
