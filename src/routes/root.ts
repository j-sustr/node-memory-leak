import { FastifyPluginAsync } from "fastify";


let memoryConsumer: { id: number; data: string; }[] = [];


const root: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  fastify.get("/", async function (request, reply) {
    return { root: true };
  });

  // A route to intentionally consume a large amount of memory
  fastify.get("/stress-memory", async (request, reply) => {
    request.log.info("Starting to allocate a large amount of memory...");

    // Allocate memory in chunks to avoid blocking the event loop for too long
    // Each object is roughly 100 characters, so 1 million objects is ~100MB
    const numItems = 2_000_000; // Adjust this number based on your memoryThresholdMB
    for (let i = 0; i < numItems; i++) {
      memoryConsumer.push({
        id: i,
        data: `This is some test data to consume memory. Item number ${i}`.repeat(
          10
        ),
      });
    }

    request.log.info(
      "Finished allocating memory. The memory monitor should trigger a snapshot soon."
    );
    reply.send({
      message:
        "Memory allocation complete. Check logs for heap snapshot creation.",
    });
  });

  // A route to clear the allocated memory
  fastify.get("/clear-memory", async (request, reply) => {
    request.log.info("Clearing memory consumer array.");
    memoryConsumer = [];
    // The next GC cycle will reclaim the memory
    reply.send({
      message:
        "Memory has been cleared. The next garbage collection cycle will free the memory.",
    });
  });
};

export default root;
