import { startEmbeddedServer } from '../desktop/embedded-server.ts';

// Reuse the upstream production server and all its request-origin protections.
const { server, origin } = await startEmbeddedServer('/app/dist');
console.log(`OpenChatCut production server ready: ${origin}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
