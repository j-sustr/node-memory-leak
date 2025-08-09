import { FastifyPluginAsync } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getHeapSnapshot } from "v8";
import { createWriteStream } from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { readdir, unlink, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== TYPES =====
interface CleanupQuery {
  seconds: number;
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
  return path.join(__dirname, "../../snapshots");
};

const generateSnapshotFileName = (): string => {
  const isoTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `heap-snapshot-${isoTimestamp}.heapsnapshot`;
};

const calculateCutoffDate = (seconds: number): Date => {
  return new Date(Date.now() - seconds * 1000);
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

      snapshotStream.on("end", () => {
        resolve(fileName);
      });

      snapshotStream.on("error", (error) => {
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

  async cleanupOldSnapshots(seconds: number): Promise<CleanupResponse> {
    const cutoffDate = calculateCutoffDate(seconds);
    const files = await readdir(this.snapshotsDir);
    const heapSnapshotFiles = files.filter((file) =>
      file.endsWith(".heapsnapshot")
    );

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
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(`Failed to delete ${file}: ${errorMessage}`);
      }
    }

    return {
      message: `Cleanup completed. Deleted ${deletedCount} heap snapshot(s) older than ${seconds} seconds.`,
      deletedFiles,
      deletedCount,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// ===== MAIN PLUGIN =====
const heapSnapshot: FastifyPluginAsync = async (fastify): Promise<void> => {
  const snapshotService = new SnapshotService();

  fastify.get("/heap-snapshot", async (request, reply) => {
    try {
      const fileName = await snapshotService.createSnapshot();
      reply.send({ message: `Heap snapshot written to ${fileName}` });
    } catch (error) {
      request.log.error(error, "Failed to create heap snapshot");
      reply.status(500).send({ error: "Failed to create heap snapshot" });
    }
  });

  fastify.get("/heap-snapshot/list", async (request, reply) => {
    try {
      const files = await snapshotService.listSnapshots();
      reply.send(files);
    } catch (error) {
      request.log.error(error, "Failed to read snapshots directory");
      reply.status(500).send({ error: "Failed to read snapshots directory" });
    }
  });

  fastify.get(
    "/heap-snapshot/download/:fileName",
    async (request, reply) => {
      const { fileName } = request.params as RouteParams;

      try {
        const stream = await snapshotService.getSnapshotStream(fileName);
        reply.send(stream);
      } catch (error) {
        request.log.error(error, `Failed to access file: ${fileName}`);
        reply.status(404).send({ error: `File not found: ${fileName}` });
      }
    }
  );

  fastify.delete("/heap-snapshot/cleanup", {
    schema: {
      querystring: {
        type: "object",
        required: ["seconds"],
        properties: {
          seconds: { type: "integer", minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { seconds } = request.query as CleanupQuery;

    try {
      const result = await snapshotService.cleanupOldSnapshots(seconds);
      reply.send(result);
    } catch (error) {
      request.log.error(error, "Failed to cleanup snapshots");
      reply.status(500).send({ error: "Failed to cleanup snapshots" });
    }
  });
};

export default fastifyPlugin(heapSnapshot);
