import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { getHeapSnapshot } from 'v8';
import { createWriteStream } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { createReadStream, readdirSync, unlinkSync, statSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const heapSnapshot: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
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

  fastify.delete('/heap-snapshot/cleanup', async (request, reply) => {
    const { days } = request.query as { days?: string };
    
    if (!days || isNaN(Number(days))) {
      return reply.status(400).send({ 
        error: 'Please provide a valid number of days as a query parameter (e.g., ?days=7)' 
      });
    }

    const daysThreshold = Number(days);
    const cutoffDate = new Date(Date.now() - (daysThreshold * 24 * 60 * 60 * 1000));
    
    try {
      const files = readdirSync(snapshotsDir);
      const heapSnapshotFiles = files.filter(file => file.endsWith('.heapsnapshot'));
      
      let deletedCount = 0;
      const deletedFiles: string[] = [];
      const errors: string[] = [];

      for (const file of heapSnapshotFiles) {
        try {
          const filePath = path.join(snapshotsDir, file);
          const stats = statSync(filePath);
          
          if (stats.mtime < cutoffDate) {
            unlinkSync(filePath);
            deletedFiles.push(file);
            deletedCount++;
          }
        } catch (error) {
          if (error instanceof Error) {
            errors.push(`Failed to delete ${file}: ${error.message}`);
          } else {
            errors.push(`Failed to delete ${file}: Unknown error`);
          }
        }
      }

      reply.send({
        message: `Cleanup completed. Deleted ${deletedCount} heap snapshot(s) older than ${daysThreshold} days.`,
        deletedFiles,
        deletedCount,
        errors: errors.length > 0 ? errors : undefined
      });

    } catch (error) {
      fastify.log.error(error, 'Failed to read snapshots directory');

      reply.status(500).send({
        error: 'Failed to read snapshots directory',
      });
    }
  });
};

export default fastifyPlugin(heapSnapshot);