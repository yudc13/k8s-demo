const http = require('http');
const os = require('os');

const PORT = Number(process.env.PORT || 8080);
const GREETING = process.env.GREETING || 'Hello from backend';
const STARTED_AT = new Date().toISOString();

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url === '/api/hello') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      message: GREETING,
      pod: os.hostname(),
      startedAt: STARTED_AT,
      time: new Date().toISOString(),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found', path: url }));
});

server.listen(PORT, () => {
  console.log(`backend listening on :${PORT}, pod=${os.hostname()}`);
});

// 让 Kubernetes 滚动更新时能优雅退出
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
