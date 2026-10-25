// Preloaded with `node --import` in the no-credentials tests: records every outbound fetch() and TCP connect
// (undici's fetch also goes through net.Socket#connect) to $NET_SPY_FILE, and blocks fetch.
import fs from 'node:fs';
import net from 'node:net';
const file = process.env.NET_SPY_FILE;
const rec = (line) => fs.appendFileSync(file, `${line}\n`);
globalThis.fetch = async (url) => { rec(`fetch ${url}`); throw new Error('network blocked by netSpy'); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0];
  rec(`connect ${typeof a === 'object' && a ? `${a.host || ''}:${a.port || a.path || ''}` : String(a)}`);
  return connect.apply(this, args);
};
