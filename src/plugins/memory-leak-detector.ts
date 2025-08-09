
import { FastifyPluginAsync } from 'fastify';
import { getHeapSnapshot } from 'v8';
import { createWriteStream, readdirSync, createReadStream } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const memoryLeakDetector: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
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

export default memoryLeakDetector;
