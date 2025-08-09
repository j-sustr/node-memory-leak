import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getHeapSnapshot } from "v8";
import { createWriteStream, createReadStream, ReadStream } from "node:fs";
import { readdir, unlink, stat, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "path";

// ===== PATH CONSTANTS =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE_NAME_REGEX = /^[a-zA-Z0-9._-]+\.heapsnapshot$/;

// ===== TYPES =====
declare module "fastify" {
  interface FastifyRequest {
    routerPath?: string;
  }
}
interface PluginOptions {
  adminApiKey?: string;
  maxConcurrentCreates?: number;
  maxDeleteThreshold?: number;
  snapshotsDir?: string;
}
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

// ===== HELPERS =====
const defaultSnapshotsDirectory = () => path.join(__dirname, "../../snapshots");
const generateSnapshotFileName = () =>
  `heap-snapshot-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.heapsnapshot`;
const calculateCutoffDate = (seconds: number) =>
  new Date(Date.now() - seconds * 1000);

// ===== SNAPSHOT SERVICE =====
class SnapshotService {
  private creatingCount = 0;
  constructor(
    private snapshotsDir: string,
    private maxConcurrentCreates: number = 1
  ) {}
  async ensureDirExists() {
    await mkdir(this.snapshotsDir, { recursive: true });
  }

  private async acquireCreateSlot() {
    while (this.creatingCount >= this.maxConcurrentCreates) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.creatingCount++;
  }
  private releaseCreateSlot() {
    if (this.creatingCount > 0) this.creatingCount--;
  }

  async createSnapshot(): Promise<string> {
    await this.acquireCreateSlot();
    try {
      const fileName = generateSnapshotFileName();
      const filePath = path.join(this.snapshotsDir, fileName);
      const snapshotStream = getHeapSnapshot();

      await new Promise<void>((resolve, reject) => {
        const fileStream = createWriteStream(filePath, { flags: "wx" });
        snapshotStream.pipe(fileStream);
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
        snapshotStream.on("error", reject);
      });
      return fileName;
    } finally {
      this.releaseCreateSlot();
    }
  }

  async listSnapshots(): Promise<string[]> {
    return (await readdir(this.snapshotsDir)).filter((f) =>
      f.endsWith(".heapsnapshot")
    );
  }

  async getSnapshotStream(fileName: string): Promise<ReadStream> {
    if (!FILE_NAME_REGEX.test(fileName)) {
      const err = new Error("Invalid file name");
      (err as any).code = "EINVALIDNAME";
      throw err;
    }
    const filePath = path.join(this.snapshotsDir, fileName);
    await stat(filePath);
    return createReadStream(filePath);
  }

  async cleanupOldSnapshots(seconds: number): Promise<CleanupResponse> {
    const cutoff = calculateCutoffDate(seconds);
    const files = (await readdir(this.snapshotsDir)).filter((f) =>
      f.endsWith(".heapsnapshot")
    );

    const deletedFiles: string[] = [];
    const errors: string[] = [];

    for (const file of files) {
      try {
        const filePath = path.join(this.snapshotsDir, file);
        if ((await stat(filePath)).mtime < cutoff) {
          await unlink(filePath);
          deletedFiles.push(file);
        }
      } catch (err) {
        errors.push(
          `Failed to delete ${file}: ${
            (err as Error)?.message ?? "Unknown error"
          }`
        );
      }
    }
    return {
      message: `Cleanup completed. Deleted ${deletedFiles.length} snapshot(s) older than ${seconds} seconds.`,
      deletedFiles,
      deletedCount: deletedFiles.length,
      errors: errors.length ? errors : undefined,
    };
  }

  async listSnapshotsOlderThan(seconds: number): Promise<string[]> {
    const cutoff = calculateCutoffDate(seconds);
    const matches: string[] = [];
    for (const file of await this.listSnapshots()) {
      try {
        if ((await stat(path.join(this.snapshotsDir, file))).mtime < cutoff) {
          matches.push(file);
        }
      } catch {}
    }
    return matches;
  }
}

// ===== MAIN PLUGIN =====
const heapSnapshot: FastifyPluginAsync<PluginOptions> = async (
  fastify,
  opts
) => {
  const adminApiKey = opts.adminApiKey ?? process.env.ADMIN_API_KEY ?? "";
  const maxConcurrentCreates = opts.maxConcurrentCreates ?? 1;
  const maxDeleteThreshold = opts.maxDeleteThreshold ?? 100;
  const snapshotsDir = opts.snapshotsDir ?? defaultSnapshotsDirectory();

  const service = new SnapshotService(snapshotsDir, maxConcurrentCreates);
  await service.ensureDirExists();

  // --- Auth middleware ---
  const verifyAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!adminApiKey)
      return reply.status(401).send({ error: "Admin API not configured" });
    const provided = (req.headers["x-admin-key"] as string) || "";
    if (provided !== adminApiKey)
      return reply.status(401).send({ error: "Unauthorized" });
  };

  // --- Routes ---
  fastify.get(
    "/heap-snapshot",
    { preHandler: verifyAdmin },
    async (req, reply) => {
      try {
        const fileName = await service.createSnapshot();
        reply
          .code(200)
          .send({ message: `Heap snapshot written to ${fileName}` });
      } catch {
        reply.status(500).send({ error: "Failed to create heap snapshot" });
      }
    }
  );

  fastify.get(
    "/heap-snapshot/list",
    { preHandler: verifyAdmin },
    async (_, reply) => {
      try {
        reply.code(200).send(await service.listSnapshots());
      } catch {
        reply.status(500).send({ error: "Failed to read snapshots directory" });
      }
    }
  );

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
    async (req, reply) => {
      const { fileName } = req.params as RouteParams;
      try {
        const stream = await service.getSnapshotStream(fileName);
        reply.header("Content-Type", "application/octet-stream");
        reply.header(
          "Content-Disposition",
          `attachment; filename="${fileName}"`
        );
        reply.send(stream);
      } catch (err: any) {
        if (err.code === "ENOENT")
          return reply
            .status(404)
            .send({ error: `File not found: ${fileName}` });
        if (err.code === "EINVALIDNAME")
          return reply.status(400).send({ error: "Invalid file name" });
        reply.status(500).send({ error: "Failed to access file" });
      }
    }
  );

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
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { seconds } = req.query as CleanupQuery;
      const force =
        ((req.headers["x-force-cleanup"] as string) || "").toLowerCase() ===
        "true";
      try {
        const candidates = await service.listSnapshotsOlderThan(seconds);
        if (!candidates.length)
          return reply
            .code(200)
            .send({
              message: "No snapshots matched cleanup criteria",
              deletedFiles: [],
              deletedCount: 0,
            });
        if (candidates.length > maxDeleteThreshold && !force) {
          return reply
            .status(429)
            .send({
              error: `Would delete ${candidates.length} files, above threshold ${maxDeleteThreshold}. Use X-Force-Cleanup: true to force.`,
            });
        }
        reply.code(200).send(await service.cleanupOldSnapshots(seconds));
      } catch {
        reply.status(500).send({ error: "Failed to cleanup snapshots" });
      }
    }
  );
};

export default fastifyPlugin(heapSnapshot, { name: "heap-snapshot-plugin" });
