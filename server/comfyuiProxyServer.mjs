import http from 'node:http';
import { createComfyuiProxyHandler } from './comfyuiProxyCore.mjs';

const PORT = Number.parseInt(process.env.COMFYUI_PROXY_PORT || process.env.PORT || '8788', 10);
const HOST = process.env.COMFYUI_PROXY_HOST || '0.0.0.0';

const handler = createComfyuiProxyHandler();

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: 'ComfyUI proxy internal error.',
      detail: error?.message || String(error),
    }));
  });
});

server.listen(PORT, HOST, () => {
  console.info(`[ComfyUI Proxy] listening on http://${HOST}:${PORT}`);
});
