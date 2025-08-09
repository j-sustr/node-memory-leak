
import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { getHeapSnapshot } from 'v8';
import { createWriteStream } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { createReadStream, readdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const heapSnapshot: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  console.log('Heap snapshot plugin loading...');

  // Add a check to prevent duplicate route registration
  // if (fastify.hasRoute({ method: 'GET', url: '/heap-snapshot' })) {
  //   console.log('Route /heap-snapshot already registered. Skipping.');
  //   return;
  // }

  const snapshotsDir = path.join(__dirname, '../../snapshots');

  fastify.get('/heap-snapshot', (request, reply) => {
    const snapshotStream = getHeapSnapshot();
    const fileName = `heap-snapshot-${Date.now()}.heapsnapshot`;
    const filePath = path.join(snapshotsDir, fileName);
    const fileStream = createWriteStream(filePath);
    snapshotStream.pipe(fileStream);

    snapshotStream.on('end', () => {
      reply.send({ message: `Heap snapshot written to ${fileName}` });
    });
  });

  fastify.get('/heap-snapshot/list', (request, reply) => {
    const files = readdirSync(snapshotsDir);
    reply.send(files);
  });

  fastify.get('/heap-snapshot/download/:fileName', (request, reply) => {
    const { fileName } = request.params as { fileName: string };
    const filePath = path.join(snapshotsDir, fileName);
    const stream = createReadStream(filePath);
    reply.send(stream);
  });
};

export default fastifyPlugin(heapSnapshot);
