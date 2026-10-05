import type { IpcApi } from '@shared/types';

declare global {
  interface Window {
    stlSherpa: IpcApi;
  }
}

export { };
