import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';

const require = createRequire(import.meta.url);
const vercelRequire = createRequire(require.resolve('vercel/package.json'));
const proxyRequire = createRequire(vercelRequire.resolve('proxy-agent'));
const { ProxyAgent } = vercelRequire('proxy-agent');
const pacRequire = createRequire(proxyRequire.resolve('pac-proxy-agent'));
const getUriRequire = createRequire(pacRequire.resolve('get-uri'));
const { getUri } = getUriRequire('get-uri');
const basicFtpPackage = getUriRequire('basic-ftp/package.json');

async function ftpServer(t, { pasvHost = '127.0.0.1', listing, file = 'ftp contents' } = {}) {
  const sockets = new Set();
  const commands = [];
  let dataSocket;
  let dataConnections = 0;
  const dataServer = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    dataSocket = socket;
    dataConnections++;
  });
  dataServer.listen(0, '127.0.0.1');
  await once(dataServer, 'listening');
  const dataPort = dataServer.address().port;
  const controlServer = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 Ready\r\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const command = line.split(' ')[0];
        commands.push(command);
        if (command === 'USER') socket.write('331 Password required\r\n');
        else if (command === 'PASS') socket.write('230 Logged in\r\n');
        else if (command === 'FEAT')
          socket.write('211-Features\r\n MLST type*;modify*;\r\n211 End\r\n');
        else if (command === 'MDTM')
          socket.write(listing ? '502 Unsupported\r\n' : '213 20260101000000\r\n');
        else if (command === 'EPSV') socket.write('502 Unsupported\r\n');
        else if (command === 'PASV')
          socket.write(
            `227 Entering Passive Mode (${pasvHost.replaceAll('.', ',')},${dataPort >> 8},${dataPort & 255})\r\n`
          );
        else if (command === 'MLSD' || command === 'RETR') {
          socket.write('150 Opening data connection\r\n');
          dataSocket.end(command === 'MLSD' ? listing : file);
          socket.write('226 Transfer complete\r\n');
        } else if (command === 'QUIT') socket.end('221 Goodbye\r\n');
        else socket.write('200 OK\r\n');
      }
    });
  });
  controlServer.listen(0, '127.0.0.1');
  await once(controlServer, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise(resolve => controlServer.close(resolve)),
      new Promise(resolve => dataServer.close(resolve)),
    ]);
  });
  return {
    url: `ftp://127.0.0.1:${controlServer.address().port}/file.txt`,
    commands,
    get dataConnections() {
      return dataConnections;
    },
  };
}

async function contents(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('get-uri resolves the intended basic-ftp version', () => {
  assert.equal(basicFtpPackage.version, '6.2.6');
});

test('get-uri retrieves a file over standard FTP', { timeout: 5000 }, async t => {
  const server = await ftpServer(t);
  const stream = await getUri(server.url);
  assert.equal(await contents(stream), 'ftp contents');
  assert.ok(server.commands.includes('RETR'));
  assert.equal(server.dataConnections, 1);
});

test('Vercel proxy agent loads a PAC file over FTP', { timeout: 5000 }, async t => {
  const ftp = await ftpServer(t, {
    file: 'function FindProxyForURL(url, host) { return "DIRECT"; }',
  });
  const destination = http.createServer((request, response) => response.end('destination'));
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  t.after(() => new Promise(resolve => destination.close(resolve)));
  const agent = new ProxyAgent({ getProxyForUrl: () => `pac+${ftp.url}` });
  t.after(() => agent.destroy());
  const response = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${destination.address().port}/`, { agent }, resolve)
      .on('error', reject);
  });
  assert.equal(await contents(response), 'destination');
  assert.ok(ftp.commands.includes('RETR'));
});

test('get-uri rejects a PASV response redirecting to another host', { timeout: 5000 }, async t => {
  const server = await ftpServer(t, {
    pasvHost: '192.0.2.1',
    listing: 'type=file;modify=20260101000000; file.txt\r\n',
  });
  await assert.rejects(getUri(server.url), /PASV returned another host/);
  assert.ok(server.commands.includes('PASV'));
  assert.equal(server.dataConnections, 0);
});

test('get-uri handles an MLSD listing containing a __proto__ fact', { timeout: 5000 }, async t => {
  const server = await ftpServer(t, {
    listing: '__proto__=x;type=file;modify=20260101000000; file.txt\r\n',
  });
  const stream = await getUri(server.url);
  assert.equal(await contents(stream), 'ftp contents');
  assert.ok(server.commands.includes('MLSD'));
});
