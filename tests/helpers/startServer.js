import path from 'path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverProcess = null;
let serverPort = null;

async function waitForServer(port, process, startupErrors, maxRetries = 30, interval = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    if (process.exitCode !== null || process.signalCode !== null) {
      const detail = startupErrors.length > 0 ? `: ${startupErrors.join('; ')}` : '';
      throw new Error(`Server process exited before port ${port} became ready${detail}`);
    }
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Server failed to start on port ${port} after ${maxRetries} attempts`);
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => {
        if (error) {
          reject(error);
        } else if (!freePort) {
          reject(new Error('Unable to determine an available test server port'));
        } else {
          resolve(freePort);
        }
      });
    });
  });
}

async function terminateProcess(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(forceKillTimer);
      resolve();
    };
    const forceKillTimer = setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill('SIGKILL');
      }
    }, 5000);
    forceKillTimer.unref();
    process.once('close', finish);
    process.kill('SIGTERM');
  });
}

async function startServer(port = 0, extraEnv = {}) {
  const cfg = loadConfig();
  const pluginDir = path.join(__dirname, '../..');
  const requestedPort = Number(port) > 0 ? Number(port) : 0;
  const maxAttempts = requestedPort ? 1 : 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const usePort = requestedPort || await findFreePort();
    const startupErrors = [];
    const log = {
      info: (msg) => { if (cfg.serverEnv.DEBUG_SERVER) console.log(msg); },
      error: (msg) => {
        startupErrors.push(msg);
        if (cfg.serverEnv.DEBUG_SERVER) console.error(msg);
      },
    };

    const process = launchServer({
      pluginDir,
      port: usePort,
      env: { ...cfg.serverEnv, DEBUG_RESPONSES: 'false', ...extraEnv },
      log,
    });

    process.on('error', (err) => {
      startupErrors.push(err.message);
      console.error('Failed to start server:', err);
    });

    serverProcess = process;
    serverPort = usePort;

    try {
      await waitForServer(usePort, process, startupErrors);
      console.log(`camofox-browser server started on port ${usePort}`);
      return usePort;
    } catch (error) {
      lastError = error;
      await terminateProcess(process);
      serverProcess = null;
      serverPort = null;
      if (attempt < maxAttempts) {
        console.warn(`Retrying test server startup after attempt ${attempt}/${maxAttempts}: ${error.message}`);
      }
    }
  }

  throw lastError;
}

async function stopServer() {
  if (serverProcess) {
    const process = serverProcess;
    await terminateProcess(process);
    serverProcess = null;
    serverPort = null;
  }
}

function getServerUrl() {
  if (!serverPort) throw new Error('Server not started');
  return `http://localhost:${serverPort}`;
}

function getServerPort() {
  return serverPort;
}

export {
  startServer,
  stopServer,
  getServerUrl,
  getServerPort
};
