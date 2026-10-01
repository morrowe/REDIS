import { createClient } from 'redis';

const url = process.env.REDIS_URL || 'redis://localhost:6379';

export function createRedisClient() {
  const client = createClient({ url });
  client.on('error', (error) => console.error('Redis error:', error.message));
  return client;
}

export async function connectRedis() {
  const client = createRedisClient();
  await client.connect();
  return client;
}
