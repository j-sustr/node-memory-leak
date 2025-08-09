import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { getHeapSnapshot } from 'v8';
import { createWriteStream } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { readdir, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== TYPES =====
interface CleanupQuery {
  days?: string;
}

interface RouteParams {
  fileName: string;
}

interface CleanupResponse {
  message: string;
  deletedFiles: string[];
  deletedCount: number;
  errors?: string[];
}

// ===== UTILITIES =====
const getSnapshotsDirectory = (): string => {
  return path.join(__dirname, '../../snapshots');
};

const generateSnapshotFileName = (): string => {
  const isoTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `heap-snapshot-${isoTimestamp}.heapsnapshot`;
};

const validateDaysParameter = (days?: string): number | null => {
  if (!days || isNaN(Number(days))) {
    return null;
  }
  return Number(days);
};

const calculateCutoffDate = (days: number): Date => {
  return new Date(Date.now() - (days * 24 * 60 * 60 * 1000));
};

// ===== SNAPSHOT SERVICE =====
class SnapshotService {
  private snapshotsDir: string;

  constructor() {
    this.snapshotsDir = getSnapshotsDirectory();
  }

  async createSnapshot(): Promise<string> {
    return new Promise((resolve, reject) => {
      const snapshotStream = getHeapSnapshot();
      const fileName = generateSnapshotFileName();
      const filePath = path.join(this.snapshotsDir, fileName);
      const fileStream = createWriteStream(filePath);
      
      snapshotStream.pipe(fileStream);

      snapshotStream.on('end', () => {
        resolve(fileName);
      });

      snapshotStream.on('error', (error) => {
        reject(error);
      });
    });
  }

  async listSnapshots(): Promise<string[]> {
    return await readdir(this.snapshotsDir);
  }

  async getSnapshotStream(fileName: string) {
    const filePath = path.join(this.snapshotsDir, fileName);
    await stat(filePath); // Check if file exists
    return createReadStream(filePath);
  }

  async cleanupOldSnapshots(days: number): Promise<CleanupResponse> {
    const cutoffDate = calculateCutoffDate(days);
    const files = await readdir(this.snapshotsDir);
    const heapSnapshotFiles = files.filter(file => file.endsWith('.heapsnapshot'));
    
    let deletedCount = 0;
    const deletedFiles: string[] = [];
    const errors: string[] = [];

    for (const file of heapSnapshotFiles) {
      try {
        const filePath = path.join(this.snapshotsDir, file);
        const stats = await stat(filePath);
        
        if (stats.mtime < cutoffDate) {
          await unlink(filePath);
          deletedFiles.push(file);
          deletedCount++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Failed to delete ${file}: ${errorMessage}`);
      }
    }

    return {
      message: `Cleanup completed. Deleted ${deletedCount} heap snapshot(s) older than ${days} days.`,
      deletedFiles,
      deletedCount,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}

// ===== ROUTE HANDLERS =====
const createSnapshotHandler = (snapshotService: SnapshotService) => {
  return async (request: any, reply: any) => {
    try {
      const fileName = await snapshotService.createSnapshot();
      reply.send({ message: `Heap snapshot written to ${fileName}` });
    } catch (error) {
      request.log.error(error, 'Failed to create heap snapshot');
      reply.status(500).send({ error: 'Failed to create heap snapshot' });
    }
  };
};

const listSnapshotsHandler = (snapshotService: SnapshotService) => {
  return async (request: any, reply: any) => {
    try {
      const files = await snapshotService.listSnapshots();
      reply.send(files);
    } catch (error) {
      request.log.error(error, 'Failed to read snapshots directory');
      reply.status(500).send({ error: 'Failed to read snapshots directory' });
    }
  };
};

const downloadSnapshotHandler = (snapshotService: SnapshotService) => {
  return async (request: any, reply: any) => {
    const { fileName } = request.params as RouteParams;
    
    try {
      const stream = await snapshotService.getSnapshotStream(fileName);
      reply.send(stream);
    } catch (error) {
      request.log.error(error, `Failed to access file: ${fileName}`);
      reply.status(404).send({ error: `File not found: ${fileName}` });
    }
  };
};

const cleanupSnapshotsHandler = (snapshotService: SnapshotService) => {
  return async (request: any, reply: any) => {
    const { days } = request.query as CleanupQuery;
    const validDays = validateDaysParameter(days);
    
    if (validDays === null) {
      return reply.status(400).send({ 
        error: 'Please provide a valid number of days as a query parameter (e.g., ?days=7)' 
      });
    }

    try {
      const result = await snapshotService.cleanupOldSnapshots(validDays);
      reply.send(result);
    } catch (error) {
      request.log.error(error, 'Failed to cleanup snapshots');
      reply.status(500).send({ error: 'Failed to read snapshots directory' });
    }
  };
};

// ===== MAIN PLUGIN =====
const heapSnapshot: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  const snapshotService = new SnapshotService();

  // Register routes
  fastify.get('/heap-snapshot', createSnapshotHandler(snapshotService));
  fastify.get('/heap-snapshot/list', listSnapshotsHandler(snapshotService));
  fastify.get('/heap-snapshot/download/:fileName', downloadSnapshotHandler(snapshotService));
  fastify.delete('/heap-snapshot/cleanup', cleanupSnapshotsHandler(snapshotService));
};

export default fastifyPlugin(heapSnapshot);