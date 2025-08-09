
import { FastifyPluginAsync } from 'fastify';
import { getHeapSnapshot } from 'v8';
import { createWriteStream } from 'fs';

const memoryLeakDetector: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  fastify.get('/heap-snapshot', (request, reply) => {
    const snapshotStream = getHeapSnapshot();
    const fileName = `heap-snapshot-${Date.now()}.heapsnapshot`;
    const fileStream = createWriteStream(fileName);
    snapshotStream.pipe(fileStream);

    snapshotStream.on('end', () => {
      reply.send({ message: `Heap snapshot written to ${fileName}` });
    });
  });
};

export default memoryLeakDetector;
