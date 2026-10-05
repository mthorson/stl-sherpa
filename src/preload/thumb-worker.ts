import { contextBridge, ipcRenderer } from 'electron';
import { THUMB_WORKER_CHANNEL, type ThumbWorkerApi } from '@shared/thumb-worker-protocol';

const api: ThumbWorkerApi = {
  onRender(handler) {
    ipcRenderer.on(THUMB_WORKER_CHANNEL.render, (_event, request) => handler(request));
  },
  ready: () => ipcRenderer.send(THUMB_WORKER_CHANNEL.ready),
  result: (result) => ipcRenderer.send(THUMB_WORKER_CHANNEL.result, result)
};
contextBridge.exposeInMainWorld('stlSherpaWorker', api);
