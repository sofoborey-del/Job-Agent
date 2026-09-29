/**
 * A loopback bridge, so the local pages can be reached over an SSH forward without the control
 * plane ever binding to anything but loopback.
 *
 * The API refuses to listen on a non-loopback address, and that refusal is the point: nothing on a
 * network can reach it. It also means a published Docker port cannot reach it, because Docker
 * forwards to the container's bridge address rather than to its loopback.
 *
 * This process runs inside the agent's own network namespace. It accepts connections on that
 * namespace's bridge address and relays them to 127.0.0.1, where the API is listening. The port it
 * accepts on is published to the host's loopback only, so the sole ways in are a shell on the host
 * and an SSH forward from a machine the security list already admits.
 *
 * It holds no credentials and understands no HTTP. Every request that crosses it still meets the
 * same authentication the API applies to a request from its own machine: the admin token for the
 * API, and the token typed into the page for the local screens.
 */
import net from 'node:net';

const listenPort = Number(process.env.FORWARD_LISTEN_PORT ?? '3310');
const targetPort = Number(process.env.FORWARD_TARGET_PORT ?? '3210');
const idleTimeoutMs = 120_000;
const maxConnections = 32;

for (const [name, value] of [
  ['FORWARD_LISTEN_PORT', listenPort],
  ['FORWARD_TARGET_PORT', targetPort],
]) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} is invalid`);
  }
}

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, '127.0.0.1');
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.setTimeout(idleTimeoutMs, close);
  upstream.setTimeout(idleTimeoutMs, close);
  for (const socket of [client, upstream]) {
    socket.on('error', close);
    socket.on('close', close);
  }
  client.pipe(upstream);
  upstream.pipe(client);
});

server.maxConnections = maxConnections;

server.listen(listenPort, () => {
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      message: 'Tracker access bridge listening',
      fields: { listenPort, targetPort, maxConnections },
    })}\n`,
  );
});

const stop = () => {
  server.close(() => {
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
