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
  // Auto-monitoring options
  autoMonitorEnabled?: boolean;
  memoryThresholdMB?: number;
  monitorIntervalSeconds?: number;
  maxAutoSnapshots?: number;
  autoSnapshotPrefix?: string;
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
interface MonitoringStatus {
  enabled: boolean;
  thresholdMB: number;
  intervalSeconds: number;
  maxSnapshots: number;
  currentMemoryMB: number;
  autoSnapshotsCount: number;
  lastSnapshotTime?: Date;
  lastCheckTime: Date;
}

// ===== HELPERS =====
const defaultSnapshotsDirectory = () => path.join(__dirname, "../../snapshots");
const generateSnapshotFileName = (prefix = "heap-snapshot") =>
  `${prefix}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.heapsnapshot`;
const calculateCutoffDate = (seconds: number) =>
  new Date(Date.now() - seconds * 1000);
const getMemoryUsageMB = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

// ===== SNAPSHOT SERVICE =====
class SnapshotService {
  private creatingCount = 0;
  private monitorTimer?: NodeJS.Timeout;
  private autoSnapshotsCount = 0;
  private lastSnapshotTime?: Date;
  private lastCheckTime = new Date();
  
  constructor(
    private snapshotsDir: string,
    private maxConcurrentCreates: number = 1,
    private autoMonitorEnabled: boolean = false,
    private memoryThresholdMB: number = 512,
    private monitorIntervalSeconds: number = 60,
    private maxAutoSnapshots: number = 10,
    private autoSnapshotPrefix: string = "auto-heap-snapshot"
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

  async createSnapshot(prefix = "heap-snapshot", isAuto = false): Promise<string> {
    await this.acquireCreateSlot();
    try {
      const fileName = generateSnapshotFileName(prefix);
      const filePath = path.join(this.snapshotsDir, fileName);
      const snapshotStream = getHeapSnapshot();

      await new Promise<void>((resolve, reject) => {
        const fileStream = createWriteStream(filePath, { flags: "wx" });
        snapshotStream.pipe(fileStream);
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
        snapshotStream.on("error", reject);
      });
      
      if (isAuto) {
        this.autoSnapshotsCount++;
        this.lastSnapshotTime = new Date();
        console.log(`📸 Auto-created heap snapshot: ${fileName} (${this.autoSnapshotsCount}/${this.maxAutoSnapshots})`);
      }
      
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
    const stats = await stat(filePath);
    console.log(`Serving ${fileName}, size=${stats.size} bytes`);
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
          
          // Update auto snapshot count if we deleted an auto snapshot
          if (file.includes(this.autoSnapshotPrefix) && this.autoSnapshotsCount > 0) {
            this.autoSnapshotsCount--;
          }
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

  // ===== AUTO-MONITORING METHODS =====
  
  private async checkMemoryAndCreateSnapshot() {
    this.lastCheckTime = new Date();
    const currentMemoryMB = getMemoryUsageMB();
    
    console.log(`🔍 Memory check: ${currentMemoryMB}MB (threshold: ${this.memoryThresholdMB}MB)`);
    
    if (currentMemoryMB >= this.memoryThresholdMB) {
      if (this.autoSnapshotsCount >= this.maxAutoSnapshots) {
        console.log(`⚠️  Memory threshold exceeded but max auto snapshots reached (${this.maxAutoSnapshots})`);
        return;
      }
      
      try {
        console.log(`🚨 Memory threshold exceeded! Creating auto snapshot...`);
        await this.createSnapshot(this.autoSnapshotPrefix, true);
      } catch (err) {
        console.error(`❌ Failed to create auto snapshot:`, err);
      }
    }
  }

  startAutoMonitoring() {
    if (!this.autoMonitorEnabled || this.monitorTimer) {
      return;
    }

    console.log(`🎯 Starting auto memory monitoring (threshold: ${this.memoryThresholdMB}MB, interval: ${this.monitorIntervalSeconds}s, max snapshots: ${this.maxAutoSnapshots})`);
    
    this.monitorTimer = setInterval(() => {
      this.checkMemoryAndCreateSnapshot().catch(err => {
        console.error('Error in auto memory monitoring:', err);
      });
    }, this.monitorIntervalSeconds * 1000);

    // Initial check
    this.checkMemoryAndCreateSnapshot().catch(err => {
      console.error('Error in initial memory check:', err);
    });
  }

  stopAutoMonitoring() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
      console.log('🛑 Stopped auto memory monitoring');
    }
  }

  getMonitoringStatus(): MonitoringStatus {
    return {
      enabled: this.autoMonitorEnabled && !!this.monitorTimer,
      thresholdMB: this.memoryThresholdMB,
      intervalSeconds: this.monitorIntervalSeconds,
      maxSnapshots: this.maxAutoSnapshots,
      currentMemoryMB: getMemoryUsageMB(),
      autoSnapshotsCount: this.autoSnapshotsCount,
      lastSnapshotTime: this.lastSnapshotTime,
      lastCheckTime: this.lastCheckTime,
    };
  }

  async resetAutoSnapshotCounter() {
    // Count existing auto snapshots to sync the counter
    const files = await this.listSnapshots();
    this.autoSnapshotsCount = files.filter(f => f.includes(this.autoSnapshotPrefix)).length;
    console.log(`🔄 Reset auto snapshot counter to ${this.autoSnapshotsCount}`);
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
  
  // Auto-monitoring options
  const autoMonitorEnabled = opts.autoMonitorEnabled ?? false;
  const memoryThresholdMB = opts.memoryThresholdMB ?? 512;
  const monitorIntervalSeconds = opts.monitorIntervalSeconds ?? 60;
  const maxAutoSnapshots = opts.maxAutoSnapshots ?? 10;
  const autoSnapshotPrefix = opts.autoSnapshotPrefix ?? "auto-heap-snapshot";

  const service = new SnapshotService(
    snapshotsDir, 
    maxConcurrentCreates,
    autoMonitorEnabled,
    memoryThresholdMB,
    monitorIntervalSeconds,
    maxAutoSnapshots,
    autoSnapshotPrefix
  );
  
  await service.ensureDirExists();
  await service.resetAutoSnapshotCounter();

  // Start auto-monitoring if enabled
  if (autoMonitorEnabled) {
    service.startAutoMonitoring();
    
    // Stop monitoring on server close
    fastify.addHook('onClose', async () => {
      service.stopAutoMonitoring();
    });
  }

  // --- Auth middleware ---
  const verifyAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!adminApiKey)
      return reply.status(401).send({ error: "Admin API not configured" });
    const provided = (req.headers["x-admin-key"] as string) || "";
    if (provided !== adminApiKey)
      return reply.status(401).send({ error: "Unauthorized" });
  };

  // --- Routes ---
  fastify.post(
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

  // New route: Get monitoring status
  fastify.get(
    "/heap-snapshot/monitor/status",
    { preHandler: verifyAdmin },
    async (_, reply) => {
      try {
        reply.code(200).send(service.getMonitoringStatus());
      } catch {
        reply.status(500).send({ error: "Failed to get monitoring status" });
      }
    }
  );

  // New route: Start/stop monitoring
  fastify.post(
    "/heap-snapshot/monitor/:action",
    {
      preHandler: verifyAdmin,
      schema: {
        params: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["start", "stop"] },
          },
        },
      },
    },
    async (req, reply) => {
      const { action } = req.params as { action: "start" | "stop" };
      
      try {
        if (action === "start") {
          service.startAutoMonitoring();
          reply.code(200).send({ message: "Auto-monitoring started" });
        } else {
          service.stopAutoMonitoring();
          reply.code(200).send({ message: "Auto-monitoring stopped" });
        }
      } catch (err) {
        reply.status(500).send({ error: `Failed to ${action} monitoring` });
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
            fileName: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { fileName } = req.params as RouteParams;

      try {
        if (!FILE_NAME_REGEX.test(fileName)) {
          return reply.status(400).send({ error: "Invalid file name" });
        }

        const filePath = path.join(snapshotsDir, fileName);
        const stats = await stat(filePath);

        console.log(`Serving ${fileName}, size=${stats.size} bytes`);

        // Set all headers first
        reply.raw.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Content-Length": stats.size.toString(),
        });

        // Create and pipe the stream directly to the raw response
        const stream = createReadStream(filePath);

        stream.on("error", (err) => {
          console.error(`Stream error for ${fileName}:`, err);
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(500);
            reply.raw.end("Stream error");
          } else {
            reply.raw.destroy();
          }
        });

        stream.on("end", () => {
          console.log(`✅ Successfully served ${fileName}`);
        });

        // Pipe directly to the raw response
        stream.pipe(reply.raw);

        // Return reply to prevent Fastify from trying to send anything else
        return reply;
      } catch (err: any) {
        console.error(`Download error for ${fileName}:`, err);

        if (err.code === "ENOENT") {
          return reply
            .status(404)
            .send({ error: `File not found: ${fileName}` });
        }

        return reply.status(500).send({ error: "Failed to access file" });
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
          return reply.code(200).send({
            message: "No snapshots matched cleanup criteria",
            deletedFiles: [],
            deletedCount: 0,
          });
        if (candidates.length > maxDeleteThreshold && !force) {
          return reply.status(429).send({
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