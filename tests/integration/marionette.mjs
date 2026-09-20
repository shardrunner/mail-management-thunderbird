import net from 'node:net';

// Marionette protocol v3: UTF-8 byte count + ':' + JSON. No WebDriver dependency.
class Frames {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (true) {
      const colon = this.buffer.indexOf(58);
      if (colon < 0) break;
      const prefix = this.buffer.subarray(0, colon).toString();
      if (!/^\d+$/.test(prefix) || Number(prefix) > 4 * 1024 * 1024) throw new Error('Invalid Marionette frame');
      const length = Number(prefix);
      if (this.buffer.length < colon + 1 + length) break;
      messages.push(JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString('utf8')));
      this.buffer = this.buffer.subarray(colon + 1 + length);
    }
    return messages;
  }
}
export async function connect(port, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let socket;
  while (Date.now() < deadline) {
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = net.connect({ host: '127.0.0.1', port });
        candidate.once('connect', () => resolve(candidate));
        candidate.once('error', reject);
      });
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!socket) throw new Error('Headless Thunderbird did not expose Marionette before timeout');
  const frames = new Frames();
  const pending = new Map();
  let next = 0;
  let helloResolve;
  const hello = new Promise(resolve => { helloResolve = resolve; });
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Marionette connection closed')));
  socket.on('data', chunk => {
    try {
      for (const message of frames.push(chunk)) {
        if (!Array.isArray(message)) { helloResolve(message); continue; }
        const [type, id, error, result] = message;
        if (type !== 1 || !pending.has(id)) continue;
        const entry = pending.get(id);
        pending.delete(id);
        error ? entry.reject(new Error(`Marionette: ${error.error}: ${error.message}`)) : entry.resolve(result);
      }
    } catch (error) { fail(error); socket.destroy(); }
  });
  const greeting = await Promise.race([hello, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Marionette greeting timeout')), 5000); timer.unref();
  })]);
  if (greeting.marionetteProtocol !== 3) throw new Error('Expected Marionette protocol 3');
  return {
    command(name, parameters = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} timeout`)); }, 45_000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        const body = Buffer.from(JSON.stringify([0, id, name, parameters]));
        socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
      });
    },
    close() { socket.destroy(); },
  };
}
