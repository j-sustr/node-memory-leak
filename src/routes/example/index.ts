import type { FastifyPluginAsync } from 'fastify'

const leakyData: any[] = [];

const example: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  fastify.get('/', async function (request, reply) {
    // Add a large object to the array on each request
    leakyData.push(new Array(1000000).join('x'));
    return `this is an example. Leaky data size: ${leakyData.length}`
  })
}

export default example
