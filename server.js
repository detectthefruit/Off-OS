import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const maxRequestSize = 1024 * 1024;
const maxResponseSize = 12 * 1024 * 1024;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function proxyPath(url) {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

function resolveTarget(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    return url;
  } catch {
    return null;
  }
}

export function rewriteCss(css, base) {
  return css.replace(/url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/gi, (match, quote, value) => {
    const target = resolveTarget(value, base);
    return target ? `url("${proxyPath(target.href)}")` : match;
  }).replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, value) => {
    const target = resolveTarget(value, base);
    return target ? `@import "${proxyPath(target.href)}"` : match;
  });
}

export function rewriteHtml(html, base) {
  const baseMatch = html.match(/<base\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/i);
  if (baseMatch) {
    const target = resolveTarget(baseMatch[2], base);
    if (target) base = target.href;
  }
  html = html.replace(/<base\b[^>]*>/gi, '');
  html = html.replace(/\b(href|src|action|poster|data|xlink:href)\s*=\s*(["'])(.*?)\2/gi,
    (match, attribute, quote, value) => {
      if (!value.trim() || value.trim().startsWith('#')) return match;
      const target = resolveTarget(value.trim(), base);
      return target ? `${attribute}=${quote}${proxyPath(target.href)}${quote}` : match;
    });
  html = html.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (match, quote, value) => {
    const entries = value.split(',').map((entry) => {
      const [url, ...descriptor] = entry.trim().split(/\s+/);
      const target = resolveTarget(url, base);
      return `${target ? proxyPath(target.href) : url}${descriptor.length ? ` ${descriptor.join(' ')}` : ''}`;
    });
    return `srcset=${quote}${entries.join(', ')}${quote}`;
  });
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (match, opening, css, closing) => `${opening}${rewriteCss(css, base)}${closing}`);
}

export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    return !(
      octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      octets[0] >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return !(normalized === '::1' || normalized === '::' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith('::ffff:'));
  }
  return false;
}

async function assertPublicTarget(url) {
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
    throw new Error('Local network addresses are not available through this proxy.');
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Local network addresses are not available through this proxy.');
  }
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestSize) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchTarget(initialUrl, method, body, contentType) {
  let url = initialUrl;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    await assertPublicTarget(url);
    const response = await fetch(url, {
      method,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      headers: {
        accept: '*/*',
        'user-agent': 'OffOS/1.0 (local privacy browser)',
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status < 300 || response.status >= 400 || !response.headers.get('location')) {
      return response;
    }
    if (redirect === 5) throw new Error('Too many redirects.');
    url = resolveTarget(response.headers.get('location'), url);
    if (!url) throw new Error('The destination returned an unsupported redirect.');
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      contentType = undefined;
    }
  }
  throw new Error('Too many redirects.');
}

async function handleProxy(request, response, requestUrl) {
  const target = resolveTarget(requestUrl.searchParams.get('url') ?? '');
  if (!target) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Enter a valid HTTP or HTTPS address.');
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
    response.writeHead(405, { allow: 'GET, HEAD, POST' }).end();
    return;
  }
  try {
    const body = request.method === 'POST' ? await readRequestBody(request) : undefined;
    const upstream = await fetchTarget(target, request.method, body, request.headers['content-type']);
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const headers = {
      'content-type': contentType,
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self' data: blob:; frame-ancestors 'self'; form-action 'self'; object-src 'none'",
    };
    const location = upstream.headers.get('location');
    if (location) {
      const redirected = resolveTarget(location, target);
      if (redirected) headers.location = proxyPath(redirected.href);
    }
    if (request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
      response.writeHead(upstream.status, headers).end();
      return;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > maxResponseSize) throw new Error('This response is too large to display.');
    let output = buffer;
    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      output = Buffer.from(rewriteHtml(buffer.toString('utf8'), upstream.url || target.href));
    } else if (/text\/css/i.test(contentType)) {
      output = Buffer.from(rewriteCss(buffer.toString('utf8'), upstream.url || target.href));
    }
    response.writeHead(upstream.status, headers).end(output);
  } catch (error) {
    response.writeHead(502, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    }).end(error.message || 'The destination could not be reached.');
  }
}

async function serveFile(pathname, response) {
  const path = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = normalize(join(publicDir, path));
  if (!file.startsWith(`${publicDir}/`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const content = await readFile(file);
    response.writeHead(200, {
      'content-type': mimeTypes[extname(file)] ?? 'application/octet-stream',
      'content-length': content.length,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    }).end(content);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

export function createAppServer() {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.pathname === '/api/proxy') {
      await handleProxy(request, response, requestUrl);
    } else if (request.method === 'GET' || request.method === 'HEAD') {
      await serveFile(requestUrl.pathname, response);
    } else {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
    }
  });
}

export function startLocalServers(port = Number(process.env.PORT || 4173)) {
  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const server = createAppServer();
    servers.push(server);
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') return;
      console.error(`Failed to bind Off-OS to ${host}:${port}:`, error);
    });
    server.listen(port, host, () => {
      console.log(`Off-OS is ready at http://${host}:${port}`);
    });
  }
  return servers;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startLocalServers();
}