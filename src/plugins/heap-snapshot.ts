import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getHeapSnapshot } from "v8";
import { createWriteStream } from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { readdir, unlink, stat, mkdir } from "node:fs/promises";
import { createReadStream, ReadStream, WriteStream } from "node:fs";
import { pipeline } from "stream/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

declare module "fastify" {
  interface FastifyRequest {
    routerPath?: string;
  }
}

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

// plugin options (optional)
interface PluginOptions {
  adminApiKey?: string; // override via options, otherwise process.env.ADMIN_API_KEY
  maxConcurrentCreates?: number; // default 1
  maxDeleteThreshold?: number; // how many files deletion without force is allowed
  snapshotsDir?: string; // override dir
}

// ===== UTILITIES =====
const defaultSnapshotsDirectory = (): string =>
  path.join(__dirname, "../../snapshots");

const generateSnapshotFileName = (): string => {
  const isoTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `heap-snapshot-${isoTimestamp}.heapsnapshot`;
};

const calculateCutoffDate = (seconds: number): Date => {
  return new Date(Date.now() - seconds * 1000);
};

// validate fileName to avoid path traversal and ensure .heapsnapshot suffix
const FILE_NAME_REGEX = /^[a-zA-Z0-9._-]+\.heapsnapshot$/;

// ===== SNAPSHOT SERVICE =====
class SnapshotService {
  private snapshotsDir: string;
  private creatingCount = 0;
  private maxConcurrentCreates: number;

  constructor(snapshotsDir: string, maxConcurrentCreates = 1) {
    this.snapshotsDir = snapshotsDir;
    this.maxConcurrentCreates = maxConcurrentCreates;
  }

  async ensureDirExists() {
    await mkdir(this.snapshotsDir, { recursive: true });
  }

  // simple semaphore-based concurrency limit
  private async acquireCreateSlot(): Promise<void> {
    if (this.creatingCount >= this.maxConcurrentCreates) {
      // naive wait loop - small backoff
      while (this.creatingCount >= this.maxConcurrentCreates) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    this.creatingCount++;
  }

  private releaseCreateSlot() {
    if (this.creatingCount > 0) this.creatingCount--;
  }

  async createSnapshot(): Promise<string> {
    await this.acquireCreateSlot();
    try {
      const snapshotStream = getHeapSnapshot();
      const fileName = generateSnapshotFileName();
      const filePath = path.join(this.snapshotsDir, fileName);

      await new Promise<void>((resolve, reject) => {
        const fileStream = createWriteStream(filePath, { flags: "wx" });
        snapshotStream.pipe(fileStream);
        fileStream.on("finish", () => resolve());
        fileStream.on("error", reject);
        snapshotStream.on("error", reject);
      });

      return fileName;
    } finally {
      this.releaseCreateSlot();
    }
  }

  async listSnapshots(): Promise<string[]> {
    const files = await readdir(this.snapshotsDir);
    // filter only heapsnapshot files
    return files.filter((f) => f.endsWith(".heapsnapshot"));
  }

  async getSnapshotStream(fileName: string): Promise<ReadStream> {
    if (!FILE_NAME_REGEX.test(fileName)) {
      const err = new Error("Invalid file name");
      (err as any).code = "EINVALIDNAME";
      throw err;
    }
    const filePath = path.join(this.snapshotsDir, fileName);
    await stat(filePath); // will throw if not exists
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

  // helper for dry-run selection (no deletes)
  async listSnapshotsOlderThan(seconds: number): Promise<string[]> {
    const cutoffDate = calculateCutoffDate(seconds);
    const files = await readdir(this.snapshotsDir);
    const heapSnapshotFiles = files.filter((file) =>
      file.endsWith(".heapsnapshot")
    );

    const matches: string[] = [];
    for (const file of heapSnapshotFiles) {
      try {
        const filePath = path.join(this.snapshotsDir, file);
        const stats = await stat(filePath);
        if (stats.mtime < cutoffDate) {
          matches.push(file);
        }
      } catch {
        // ignore stat errors in listing
      }
    }
    return matches;
  }
}

// ===== MAIN PLUGIN =====
const heapSnapshot: FastifyPluginAsync<PluginOptions> = async (
  fastify,
  opts
) => {
  const adminApiKey = opts?.adminApiKey ?? process.env.ADMIN_API_KEY ?? "";
  const maxConcurrentCreates = opts?.maxConcurrentCreates ?? 1;
  const maxDeleteThreshold = opts?.maxDeleteThreshold ?? 100; // if more than this, require force
  const snapshotsDir = opts?.snapshotsDir ?? defaultSnapshotsDirectory();

  const snapshotService = new SnapshotService(
    snapshotsDir,
    maxConcurrentCreates
  );
  await snapshotService.ensureDirExists();

  // ----- helper: auth preHandler -----
  const verifyAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    // If no adminApiKey configured, deny to avoid accidental exposure.
    if (!adminApiKey) {
      request.log.warn(
        { route: request.routerPath },
        "Admin API key not configured - denying access"
      );
      reply.status(401).send({ error: "Admin API not configured" });
      return;
    }

    const provided = (request.headers as any)["x-admin-key"] as
      | string
      | undefined;
    if (!provided || provided !== adminApiKey) {
      request.log.warn(
        { route: request.routerPath, ip: request.ip },
        "Unauthorized admin access attempt"
      );
      reply.status(401).send({ error: "Unauthorized" });
    }
  };

  // ----- ROUTES -----

  // Create snapshot - protected
  fastify.get(
    "/heap-snapshot",
    {
      preHandler: verifyAdmin,
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
        },
      },
    },
    async (request, reply) => {
      request.log.info(
        { action: "createSnapshot", ip: request.ip },
        "Create snapshot requested"
      );
      try {
        const fileName = await snapshotService.createSnapshot();
        request.log.info(
          { action: "createSnapshot", fileName },
          "Snapshot created"
        );
        reply
          .code(200)
          .send({ message: `Heap snapshot written to ${fileName}` });
      } catch (error) {
        request.log.error(
          { err: error, action: "createSnapshot" },
          "Failed to create heap snapshot"
        );
        reply.status(500).send({ error: "Failed to create heap snapshot" });
      }
    }
  );

  // List snapshots - protected
  fastify.get(
    "/heap-snapshot/list",
    {
      preHandler: verifyAdmin,
      schema: {
        response: {
          200: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      request.log.info(
        { action: "listSnapshots", ip: request.ip },
        "Listing snapshots"
      );
      try {
        const files = await snapshotService.listSnapshots();
        reply.code(200).send(files);
      } catch (error) {
        request.log.error(
          { err: error, action: "listSnapshots" },
          "Failed to read snapshots directory"
        );
        reply.status(500).send({ error: "Failed to read snapshots directory" });
      }
    }
  );

  // Download snapshot - protected
  fastify.get(
    "/heap-snapshot/download/:fileName",
    {
      preHandler: verifyAdmin,
      schema: {
        params: {
          type: "object",
          required: ["fileName"],
          properties: {
            fileName: { type: "string", pattern: FILE_NAME_REGEX.source },
          },
        },
      },
    },
    async (request, reply) => {
      const { fileName } = request.params as RouteParams;
      request.log.info(
        { action: "downloadSnapshot", fileName, ip: request.ip },
        "Download requested"
      );

      try {
        const stream = await snapshotService.getSnapshotStream(fileName);

        // set headers
        reply.header("Content-Type", "application/octet-stream");
        reply.header(
          "Content-Disposition",
          `attachment; filename="${fileName}"`
        );

        // handle client disconnect: if client closes, destroy the stream to free resources
        const reqRaw = request.raw as NodeJS.ReadableStream & {
          destroyed?: boolean;
        };
        const onClose = () => {
          request.log.info(
            { action: "downloadSnapshot", fileName },
            "Client disconnected while downloading snapshot"
          );
          try {
            stream.destroy();
          } catch {}
        };
        reqRaw.once("close", onClose);

        // stream errors are caught by fastify if we just reply.send(stream) but we want to log
        stream.on("error", (err) => {
          request.log.error(
            { err, fileName },
            "Stream error on snapshot download"
          );
        });

        // Fastify will handle the piping of the stream
        reply.send(stream);

        // When reply is finished, remove listener
        reply.raw.once("finish", () => {
          reqRaw.removeListener("close", onClose);
          request.log.info(
            { action: "downloadSnapshot", fileName },
            "Download finished"
          );
        });
      } catch (error) {
        if ((error as any).code === "ENOENT") {
          request.log.warn({ fileName }, "Requested snapshot not found");
          reply.status(404).send({ error: `File not found: ${fileName}` });
        } else if ((error as any).code === "EINVALIDNAME") {
          request.log.warn({ fileName }, "Invalid filename in request");
          reply.status(400).send({ error: "Invalid file name" });
        } else {
          request.log.error({ err: error, fileName }, "Failed to access file");
          reply.status(500).send({ error: "Failed to access file" });
        }
      }
    }
  );

  // Cleanup snapshots - protected
  fastify.delete(
    "/heap-snapshot/cleanup",
    {
      preHandler: verifyAdmin,
      schema: {
        querystring: {
          type: "object",
          required: ["seconds"],
          properties: {
            seconds: {
              type: "integer",
              minimum: 1,
              maximum: 60 * 60 * 24 * 3650,
            }, // up to ~10 years
          },
        },
      },
    },
    async (request, reply) => {
      const { seconds } = request.query as any as CleanupQuery;
      const force =
        (
          (request.headers as any)["x-force-cleanup"] || "false"
        ).toLowerCase() === "true";

      request.log.info(
        { action: "cleanupRequest", seconds, ip: request.ip, force },
        "Cleanup requested (dry-run)"
      );

      try {
        // Safety: compute which files would be deleted first (dry-run)
        const candidates = await snapshotService.listSnapshotsOlderThan(
          seconds
        );
        request.log.info(
          {
            action: "cleanupDryRun",
            seconds,
            candidatesCount: candidates.length,
          },
          "Cleanup dry-run completed"
        );

        if (candidates.length === 0) {
          request.log.info(
            { action: "cleanup", seconds },
            "No snapshots matched cleanup criteria"
          );
          return reply.code(200).send({
            message: "No snapshots matched cleanup criteria",
            deletedFiles: [],
            deletedCount: 0,
          } as CleanupResponse);
        }

        // If too many files will be deleted, require force header to proceed
        if (candidates.length > maxDeleteThreshold && !force) {
          request.log.warn(
            {
              action: "cleanupBlocked",
              seconds,
              candidatesCount: candidates.length,
              threshold: maxDeleteThreshold,
            },
            "Cleanup would delete too many files - blocked without X-Force-Cleanup"
          );
          return reply.status(429).send({
            error: `Cleanup would delete ${candidates.length} files which is above the allowed threshold of ${maxDeleteThreshold}. Re-run with header 'X-Force-Cleanup: true' to force deletion.`,
          });
        }

        // Audit log BEFORE deletion
        request.log.info(
          {
            action: "cleanupProceed",
            seconds,
            candidatesCount: candidates.length,
          },
          "Proceeding to delete snapshots"
        );

        const result = await snapshotService.cleanupOldSnapshots(seconds);

        request.log.info(
          { action: "cleanupComplete", result },
          "Cleanup completed"
        );
        reply.code(200).send(result);
      } catch (error) {
        request.log.error(
          { err: error, action: "cleanup" },
          "Failed to cleanup snapshots"
        );
        reply.status(500).send({ error: "Failed to cleanup snapshots" });
      }
    }
  );
};

export default fastifyPlugin(heapSnapshot, {
  name: "heap-snapshot-plugin",
});
