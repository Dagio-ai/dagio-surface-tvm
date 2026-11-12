import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createArtifactCache } = require('../lib/index.js');

// In-memory implementation of the platform file handles, not a replacement cache.
class Directory {
  entries = new Map();
  async getDirectoryHandle(name, options) {
    if (!this.entries.has(name) && options?.create) this.entries.set(name, new Directory());
    if (!this.entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
    return this.entries.get(name);
  }
  async getFileHandle(name, options) {
    if (!this.entries.has(name) && options?.create) this.entries.set(name, new FileHandle());
    if (!this.entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
    return this.entries.get(name);
  }
  async removeEntry(name) {
    this.entries.delete(name);
  }
}
class FileHandle {
  bytes = new Uint8Array();
  async getFile() {
    return new Blob([this.bytes]);
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (value) => {
        chunks.push(new Uint8Array(value).slice());
      },
      close: async () => {
        this.bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      },
      abort: async () => {},
    };
  }
  async createSyncAccessHandle() {
    return {
      getSize: () => this.bytes.byteLength,
      read: (buffer, { at = 0 } = {}) => {
        new Uint8Array(buffer.buffer ?? buffer).set(this.bytes.subarray(at));
        return this.bytes.length;
      },
      truncate: (size) => {
        this.bytes = this.bytes.slice(0, size);
      },
      write: (buffer, { at = 0 } = {}) => {
        const value = new Uint8Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
        const bytes = new Uint8Array(Math.max(this.bytes.length, at + value.length));
        bytes.set(this.bytes);
        bytes.set(value, at);
        this.bytes = bytes;
        return value.length;
      },
      flush() {},
      close() {},
    };
  }
}
const root = new Directory();
Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => root } });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function withStream(run) {
  let requests = 0;
  const firstChunk = deferred();
  const finish = deferred();
  const server = createServer(async (req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(new Uint8Array([1, 2, 3]));
    firstChunk.resolve();
    await finish.promise;
    res.end(new Uint8Array([4, 5]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({
      url: 'http://127.0.0.1:' + server.address().port + '/artifact',
      finish,
      firstChunk,
      requests: () => requests,
    });
  } finally {
    finish.resolve();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const mode of ['async', 'sync']) {
  test('native ' + mode + ' OPFS reports bytes before EOF and commits exactly once; hits do not download', async () => {
    await withStream(async ({ url, finish, requests }) => {
      const cache = createArtifactCache('test-' + crypto.randomUUID(), { cacheType: 'opfs', opfsAccessMode: mode });
      const chunk = deferred();
      const reports = [];
      let resolved = false;
      const fetch = cache
        .fetchWithCache(url, 'arraybuffer', undefined, (loaded) => {
          reports.push(loaded);
          chunk.resolve();
        })
        .then((value) => {
          resolved = true;
          return value;
        });
      await chunk.promise;
      assert.deepEqual(reports, [3]);
      assert.equal(resolved, false);
      assert.equal(await cache.hasAllKeys([url]), false);
      finish.resolve();
      assert.deepEqual(new Uint8Array(await fetch), new Uint8Array([1, 2, 3, 4, 5]));
      assert.deepEqual(reports, [3, 5]);
      assert.equal(await cache.hasAllKeys([url]), true);
      const hit = await cache.fetchWithCache(url, 'arraybuffer', undefined, () =>
        assert.fail('Cache hit must not report network bytes'),
      );
      assert.equal(hit.byteLength, 5);
      assert.equal(requests(), 1);
    });
  });
}
test('native OPFS abort leaves no committed partial entry and permits a clean retry', async () => {
  await withStream(async ({ url, finish, requests }) => {
    const cache = createArtifactCache('abort-' + crypto.randomUUID(), { cacheType: 'opfs', opfsAccessMode: 'async' });
    const controller = new AbortController();
    const chunk = deferred();
    const transfer = cache.fetchWithCache(url, 'arraybuffer', controller.signal, () => chunk.resolve());
    const rejection = assert.rejects(transfer, { name: 'AbortError' });
    await chunk.promise;
    controller.abort();
    await rejection;
    assert.equal(await cache.hasAllKeys([url]), false);
    finish.resolve();
    const reports = [];
    const bytes = await cache.fetchWithCache(url, 'arraybuffer', undefined, (loaded) => reports.push(loaded));
    assert.equal(bytes.byteLength, 5);
    assert.equal(reports.at(-1), 5);
    assert.equal(requests(), 2);
  });
});
