const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const messageEl = document.getElementById('message');
const podEl = document.getElementById('pod');
const startedEl = document.getElementById('started');
const latencyEl = document.getElementById('latency');
const refreshBtn = document.getElementById('refresh');
const countEl = document.getElementById('request-count');

let count = 0;

function setState(state, text) {
  dot.className = `dot ${state}`;
  statusText.textContent = text;
}

async function load() {
  count += 1;
  countEl.textContent = `已请求 ${count} 次`;
  setState('pending', '正在连接后端…');
  refreshBtn.disabled = true;

  const started = performance.now();
  try {
    const res = await fetch('/api/hello', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ms = Math.round(performance.now() - started);

    messageEl.textContent = data.message;
    podEl.textContent = data.pod;
    startedEl.textContent = new Date(data.startedAt).toLocaleString();
    latencyEl.textContent = `${ms} ms`;
    setState('ok', '后端连接正常');
  } catch (err) {
    messageEl.textContent = '—';
    podEl.textContent = '—';
    startedEl.textContent = '—';
    latencyEl.textContent = '—';
    setState('error', `请求失败：${err.message}`);
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', load);
load();
