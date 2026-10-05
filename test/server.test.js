import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, isPublicAddress, rewriteCss, rewriteHtml } from '../server.js';

test('classifies public and private IP addresses correctly', () => {
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('192.168.1.1'), false);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('fd12::1'), false);
  assert.equal(isPublicAddress('fe80::1'), false);
});

test('rewrites page links and stylesheet assets through the proxy', () => {
  const html = rewriteHtml('<a href="/next#part">Next</a><img src="img/photo.jpg"><a href="#part">Jump</a>', 'https://example.org/start');
  assert.match(html, /href="\/api\/proxy\?url=https%3A%2F%2Fexample\.org%2Fnext%23part"/);
  assert.match(html, /src="\/api\/proxy\?url=https%3A%2F%2Fexample\.org%2Fimg%2Fphoto\.jpg"/);
  assert.match(html, /href="#part"/);
  assert.match(rewriteCss('body{background:url("../img/bg.png")}', 'https://example.org/css/site.css'), /\/api\/proxy\?url=https%3A%2F%2Fexample\.org%2Fimg%2Fbg\.png/);
});

test('serves the PWA shell', async (context) => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /Off-OS Browser/);
});

test('rejects malformed proxy URLs and unsupported schemes', async (context) => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}/api/proxy`;

  const invalid = await fetch(`${base}?url=${encodeURIComponent('file:///etc/passwd')}`);
  assert.equal(invalid.status, 400);
  const local = await fetch(`${base}?url=${encodeURIComponent('http://127.0.0.1/admin')}`);
  assert.equal(local.status, 502);
  assert.match(await local.text(), /Local network addresses/);
});