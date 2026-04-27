const BASE = 'https://api.printful.com';

export function pf({ token, storeId }) {
  async function call(method, path, body, opts = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(storeId ? { 'X-PF-Store-Id': storeId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  }

  async function withRetry(fn, { tries = 4 } = {}) {
    for (let i = 0; i < tries; i++) {
      const r = await fn();
      if (r.status !== 429) return r;
      const msg = r.body?.error?.message || '';
      const m = msg.match(/(\d+)\s*seconds?/);
      const wait = (m ? parseInt(m[1]) : 60) + 5;
      await new Promise(r => setTimeout(r, wait * 1000));
    }
    return fn();
  }

  return {
    raw: call,
    get: (p, opts) => withRetry(() => call('GET', p, null, opts)),
    post: (p, b, opts) => withRetry(() => call('POST', p, b, opts)),
    put: (p, b, opts) => withRetry(() => call('PUT', p, b, opts)),
    del: (p, opts) => withRetry(() => call('DELETE', p, null, opts)),
  };
}
