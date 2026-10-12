// One HTTP request to an engine or to Data Control Tower.
//
// fetch() is enough until the certificate cannot be verified: lab engines and DCT appliances
// commonly serve a self-signed or expired one, and fetch takes no agent to relax that (it reads a
// dispatcher from undici, which Node bundles but does not expose). So when the user opted out of
// verification for that instance, the request goes through node:https with rejectUnauthorized
// off. Same answer either way: { ok, status, headers, buffer }.

const http = require('node:http');
const https = require('node:https');

async function request(url, { method = 'GET', headers = {}, body, insecure = false, timeoutMs = 30000 } = {}) {
  // A FormData body is serialised the way fetch would, boundary and all.
  let payload = body;
  const sendHeaders = { ...headers };
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const encoded = new Response(body);
    sendHeaders['Content-Type'] = encoded.headers.get('content-type');
    payload = Buffer.from(await encoded.arrayBuffer());
  }

  if (!insecure || !url.startsWith('https:')) {
    const res = await fetch(url, { method, headers: sendHeaders, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  }

  const data = payload == null ? null : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  if (data) sendHeaders['Content-Length'] = data.length;
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method, headers: sendHeaders, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: new Headers(Object.entries(res.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, String(v)]]))),
        buffer: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * An error body as one readable line. A proxy in front of the instance answers with an HTML page
 * ("Engine is unavailable"), and the whole page is no message: its title or first heading is.
 */
function plainError(text, status) {
  const body = String(text ?? '').trim();
  if (!body) return `HTTP ${status}`;
  if (!body.startsWith('<')) return body.slice(0, 300);
  const pick = (tag) => body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))?.[1]
    ?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = [pick('h1'), pick('pre'), pick('title')].find(Boolean);
  return words ? `HTTP ${status}: ${words}` : `HTTP ${status}`;
}

module.exports = { request, plainError };
