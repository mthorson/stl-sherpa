import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/preload.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    // Bind IPv4 loopback explicitly: Node resolves `localhost` to ::1 here,
    // and an IPv6-only listener is unreachable from Docker's host-gateway,
    // which the local dashboard's status checks arrive through (as
    // host.docker.internal — allowlisted past vite's DNS-rebinding guard).
    server: {
      host: '127.0.0.1',
      allowedHosts: ['host.docker.internal']
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          thumbWorker: resolve('src/renderer/thumb-worker.html')
        },
        // The hidden thumb-worker page runs with nodeIntegration: true so it
        // can use electron + fs at runtime. Mark them external so vite/rollup
        // doesn't try to bundle them. The visible renderer doesn't import
        // these, so externals here have no effect on its bundle.
        external: ['electron', 'fs', 'fs/promises', 'path', 'os']
      }
    }
  }
});
