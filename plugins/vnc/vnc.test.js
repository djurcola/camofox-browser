import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';

// Mock the launcher module -- index.js no longer imports child_process directly
const mockWatcher = () => {
  const proc = new EventEmitter();
  proc.pid = 12345;
  proc.exitCode = null;
  proc.killed = false;
  proc.getVncStatus = jest.fn(() => ({ running: true, display: ':0', pid: 23456 }));
  proc.kill = jest.fn(() => { proc.killed = true; });
  return proc;
};
const mockStartWatcher = jest.fn(mockWatcher);
const mockResolveVncConfig = jest.fn((pluginConfig = {}) => ({
  enabled: pluginConfig.enabled || false,
  resolution: pluginConfig.resolution
    ? (pluginConfig.resolution.split('x').length > 2 ? pluginConfig.resolution : `${pluginConfig.resolution}x24`)
    : '1920x1080x24',
  vncPassword: pluginConfig.password || '',
  viewOnly: pluginConfig.viewOnly || false,
  matchWindowToDisplay: pluginConfig.matchWindowToDisplay === true,
  vncPort: pluginConfig.vncPort || '5900',
  novncPort: pluginConfig.novncPort || '6080',
}));

jest.unstable_mockModule('./vnc-launcher.js', () => ({
  resolveVncConfig: mockResolveVncConfig,
  startWatcher: mockStartWatcher,
}));

// Mock auth middleware
jest.unstable_mockModule('../../lib/auth.js', () => ({
  requireAuth: () => (_req, _res, next) => next(),
}));

// Minimal VirtualDisplay mock (real class has side-effects that break in test)
class MockVirtualDisplay {
  get xvfb_args() {
    return ['-screen', '0', '1x1x24', '-ac', '-nolisten', 'tcp'];
  }
}

const { register } = await import('./index.js');

describe('vnc plugin', () => {
  let events, ctx, mockApp, routes;

  beforeEach(() => {
    events = createPluginEvents();
    routes = {};
    mockApp = {
      get: jest.fn((path, ...handlers) => { routes[`GET ${path}`] = handlers; }),
    };
    ctx = {
      events,
      config: {},
      log: jest.fn(),
      sessions: new Map(),
      safeError: (err) => typeof err === 'string' ? err : (err?.message || 'Internal error'),
      VirtualDisplay: MockVirtualDisplay,
      createVirtualDisplay: () => new MockVirtualDisplay(),
    };
    mockStartWatcher.mockClear();
    mockStartWatcher.mockImplementation(mockWatcher);
    mockResolveVncConfig.mockClear();
    mockResolveVncConfig.mockImplementation((pluginConfig = {}) => ({
      enabled: pluginConfig.enabled || false,
      resolution: pluginConfig.resolution
        ? (pluginConfig.resolution.split('x').length > 2 ? pluginConfig.resolution : `${pluginConfig.resolution}x24`)
        : '1920x1080x24',
      vncPassword: pluginConfig.password || '',
      viewOnly: pluginConfig.viewOnly || false,
      matchWindowToDisplay: pluginConfig.matchWindowToDisplay === true,
      vncPort: pluginConfig.vncPort || '5900',
      novncPort: pluginConfig.novncPort || '6080',
    }));
  });

  test('does not register when disabled', async () => {
    await register(mockApp, ctx, {});
    expect(mockStartWatcher).not.toHaveBeenCalled();
    expect(mockApp.get).not.toHaveBeenCalled();
  });

  test('registers when pluginConfig.enabled is true', async () => {
    await register(mockApp, ctx, { enabled: true });
    expect(mockStartWatcher).toHaveBeenCalled();
    expect(mockApp.get).toHaveBeenCalledWith(
      '/sessions/:userId/storage_state',
      expect.any(Function),
      expect.any(Function),
    );
  });

  test('status endpoint reports watcher state and configured ports without auth', async () => {
    await register(mockApp, ctx, { enabled: true, vncPort: 5901, novncPort: 6081 });

    const handlers = routes['GET /vnc/status'];
    expect(handlers).toHaveLength(1);
    const res = { json: jest.fn() };
    handlers[0]({}, res);

    expect(res.json).toHaveBeenCalledWith({
      enabled: true,
      running: true,
      watcherRunning: true,
      display: ':0',
      vncPort: 5901,
      novncPort: 6081,
      path: '/vnc.html',
    });
  });

  test('status endpoint reports a stopped watcher', async () => {
    await register(mockApp, ctx, { enabled: true });
    const proc = mockStartWatcher.mock.results[0].value;
    proc.exitCode = 1;
    proc.getVncStatus.mockReturnValue({ running: false });

    const res = { json: jest.fn() };
    routes['GET /vnc/status'][0]({}, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ running: false }));
  });

  test('passes resolved config to startWatcher', async () => {
    await register(mockApp, ctx, { enabled: true, password: 'secret', vncPort: 5901 });
    expect(mockStartWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        vncPassword: 'secret',
        vncPort: 5901,
        log: ctx.log,
        events,
      }),
    );
  });

  test('overrides createVirtualDisplay with custom resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1280x720' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1280x720x24');
  });

  test('appends x24 depth to WxH resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1920x1080' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1920x1080x24');
  });

  test('preserves explicit depth in resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1920x1080x32' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1920x1080x32');
  });

  test('matches generated browser geometry to the VNC display when configured', async () => {
    await register(mockApp, ctx, {
      enabled: true,
      resolution: '1280x1024',
      matchWindowToDisplay: true,
    });
    const options = {
      env: {
        CAMOU_CONFIG_1: JSON.stringify({
          'screen.width': 1920,
          'screen.height': 1200,
          'screen.availWidth': 1920,
          'screen.availHeight': 1160,
          'screen.colorDepth': 32,
          'screen.pixelDepth': 32,
          'window.outerWidth': 1920,
          'window.outerHeight': 1168,
          'window.screenX': 200,
          'window.screenY': 16,
          'navigator.userAgent': 'retained',
        }),
        UNRELATED_ENV: 'retained',
      },
    };

    await events.emitAsync('browser:launching', { options });

    expect(options.env.UNRELATED_ENV).toBe('retained');
    expect(JSON.parse(options.env.CAMOU_CONFIG_1)).toMatchObject({
      'screen.width': 1280,
      'screen.height': 1024,
      'screen.availWidth': 1280,
      'screen.availHeight': 1024,
      'screen.availTop': 0,
      'screen.availLeft': 0,
      'screen.colorDepth': 24,
      'screen.pixelDepth': 24,
      'window.outerWidth': 1280,
      'window.outerHeight': 1024,
      'window.screenX': 0,
      'window.screenY': 0,
      'navigator.userAgent': 'retained',
    });
  });

  test('storage_state endpoint returns 404 for unknown user', async () => {
    await register(mockApp, ctx, { enabled: true });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'unknown' }, reqId: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('storage_state endpoint returns state for active session', async () => {
    await register(mockApp, ctx, { enabled: true });

    const mockState = { cookies: [{ name: 'sid', value: 'abc' }], origins: [] };
    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => mockState) },
    });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'user-1' }, reqId: 'test' };
    const res = { json: jest.fn() };

    await handler(req, res);
    expect(ctx.sessions.get('user-1').context.storageState).toHaveBeenCalledWith(undefined);
    expect(res.json).toHaveBeenCalledWith(mockState);
  });

  test('storage_state endpoint includes IndexedDB when persistence opts in', async () => {
    ctx.persistenceStorageStateOptions = { indexedDB: true };
    await register(mockApp, ctx, { enabled: true });

    const storageState = jest.fn(async () => ({ cookies: [], origins: [] }));
    ctx.sessions.set('user-1', { context: { storageState } });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    await handler(
      { params: { userId: 'user-1' }, reqId: 'test' },
      { json: jest.fn() },
    );

    expect(storageState).toHaveBeenCalledWith({ indexedDB: true });
  });

  test('storage_state endpoint uses safeError on failure', async () => {
    await register(mockApp, ctx, { enabled: true });

    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => { throw new Error('context destroyed'); }) },
    });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'user-1' }, reqId: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    // safeError returns the message string -- not the raw Error object
    expect(res.json).toHaveBeenCalledWith({ error: 'context destroyed' });
  });

  test('emits vnc:storage:exported and session:storage:export on export', async () => {
    await register(mockApp, ctx, { enabled: true });

    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => ({ cookies: [], origins: [] })) },
    });

    const exported = [];
    events.on('vnc:storage:exported', (e) => exported.push(e));
    events.on('session:storage:export', (e) => exported.push(e));

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    await handler(
      { params: { userId: 'user-1' }, reqId: 'test' },
      { json: jest.fn() },
    );

    expect(exported).toHaveLength(2);
    expect(exported[0]).toMatchObject({ userId: 'user-1' });
    expect(exported[1]).toMatchObject({
      userId: 'user-1',
      storageState: { cookies: [], origins: [] },
    });
  });

  test('watcher is killed on server:shutdown', async () => {
    await register(mockApp, ctx, { enabled: true });

    const proc = mockStartWatcher.mock.results[0].value;
    events.emit('server:shutdown');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
