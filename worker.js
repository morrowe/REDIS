import { connectRedis } from './redis.js';

const redis = await connectRedis();
const queueKey = 'tasks:queue';
const channel = 'tasks:events';

console.log('Worker запущен. Ожидание задач...');

while (true) {
  try {
    const result = await redis.brPop(queueKey, 0);
    const id = result?.element;
    if (!id) continue;
    const key = `task:${id}`;
    if (!(await redis.exists(key))) continue;
    await redis.hSet(key, { status: 'processing' });
    await redis.publish(channel, JSON.stringify({ type: 'processing', id }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await redis.hSet(key, { status: 'completed', completedAt: new Date().toISOString() });
    await redis.publish(channel, JSON.stringify({ type: 'completed', id }));
    await redis.del('cache:stats');
  } catch (error) {
    console.error('Worker error:', error.message);
  }
}
