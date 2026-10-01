import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { connectRedis, createRedisClient } from './redis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const redis = await connectRedis();
const subscriber = await createRedisClient();
await subscriber.connect();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const taskKey = (id) => `task:${id}`;
const cacheKey = 'cache:stats';
const queueKey = 'tasks:queue';
const priorityKey = 'tasks:priority';
const tagsKey = 'tasks:tags';
const visitorsKey = 'stats:visitors';
const eventsChannel = 'tasks:events';

async function getTasks() {
  const ids = await redis.lRange('tasks:all', 0, -1);
  if (!ids.length) return [];
  const tasks = [];
  for (const id of ids) {
    const task = await redis.hGetAll(taskKey(id));
    if (task.id) {
      task.priority = Number(task.priority);
      task.tags = task.tags ? task.tags.split(',').filter(Boolean) : [];
      tasks.push(task);
    }
  }
  return tasks;
}

async function calculateStats() {
  const tasks = await getTasks();
  const stats = { total: tasks.length, pending: 0, processing: 0, completed: 0, error: 0 };
  for (const task of tasks) {
    if (task.status === 'pending') stats.pending++;
    if (task.status === 'processing') stats.processing++;
    if (task.status === 'completed') stats.completed++;
    if (task.status === 'error') stats.error++;
  }
  stats.visitors = await redis.pfCount(visitorsKey);
  return stats;
}

async function invalidateStats() {
  await redis.del(cacheKey);
}

app.get('/api/health', async (_req, res) => {
  res.json({ app: 'ok', redis: await redis.ping() });
});

app.get('/api/tasks', async (_req, res) => {
  res.json(await getTasks());
});

app.post('/api/tasks', async (req, res) => {
  const title = String(req.body.title || '').trim();
  const priority = Math.max(1, Math.min(3, Number(req.body.priority) || 2));
  const tags = Array.isArray(req.body.tags) ? req.body.tags.map(String).map((x) => x.trim()).filter(Boolean) : [];
  if (!title) return res.status(400).json({ message: 'Введите название задачи' });

  const id = randomUUID().slice(0, 8);
  const task = { id, title, priority: String(priority), status: 'pending', tags: tags.join(','), createdAt: new Date().toISOString() };

  // MULTI/EXEC: атомарно создаём Hash, добавляем в List и Sorted Set.
  const tx = redis.multi();
  tx.hSet(taskKey(id), task);
  tx.lPush('tasks:all', id);
  tx.rPush(queueKey, id);
  tx.zAdd(priorityKey, { score: priority, value: id });
  for (const tag of tags) tx.sAdd(tagsKey, tag);
  await tx.exec();
  await invalidateStats();
  await redis.publish(eventsChannel, JSON.stringify({ type: 'created', id }));
  res.status(201).json(task);
});

app.post('/api/tasks/:id/complete', async (req, res) => {
  const id = req.params.id;
  if (!(await redis.exists(taskKey(id)))) return res.status(404).json({ message: 'Задача не найдена' });
  await redis.hSet(taskKey(id), { status: 'completed', completedAt: new Date().toISOString() });
  await invalidateStats();
  await redis.publish(eventsChannel, JSON.stringify({ type: 'completed', id }));
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', async (req, res) => {
  const id = req.params.id;
  const key = taskKey(id);
  if (!(await redis.exists(key))) return res.status(404).json({ message: 'Задача не найдена' });
  await redis.del(key);
  await redis.lRem('tasks:all', 0, id);
  await redis.lRem(queueKey, 0, id);
  await redis.zRem(priorityKey, id);
  await invalidateStats();
  await redis.publish(eventsChannel, JSON.stringify({ type: 'deleted', id }));
  res.json({ ok: true });
});

app.get('/api/stats', async (_req, res) => {
  const cached = await redis.get(cacheKey);
  if (cached) return res.json({ ...JSON.parse(cached), cache: 'HIT' });
  const stats = await calculateStats();
  await redis.setEx(cacheKey, 60, JSON.stringify(stats));
  res.json({ ...stats, cache: 'MISS' });
});

app.post('/api/visitor', async (req, res) => {
  const visitor = String(req.body.visitorId || randomUUID());
  await redis.pfAdd(visitorsKey, visitor);
  await invalidateStats();
  res.json({ visitors: await redis.pfCount(visitorsKey), visitorId: visitor });
});

app.get('/api/lab', async (_req, res) => {
  const ttlKey = 'demo:ttl';
  const ttl = await redis.ttl(ttlKey);
  const queueLength = await redis.lLen(queueKey);
  const priority = await redis.zRangeWithScores(priorityKey, 0, -1);
  const tags = await redis.sMembers(tagsKey);
  const sampleString = await redis.get('demo:string');
  res.json({
    string: sampleString,
    list: { length: queueLength },
    hash: { example: (await redis.hGetAll('demo:hash')) },
    set: tags,
    sortedSet: priority,
    hyperLogLog: await redis.pfCount(visitorsKey),
    ttl: ttl,
    pubsub: eventsChannel,
    transaction: 'MULTI/EXEC используется при создании задачи'
  });
});

app.post('/api/lab/ttl', async (_req, res) => {
  await redis.setEx('demo:ttl', 60, 'Redis TTL работает');
  res.json({ ttl: await redis.ttl('demo:ttl') });
});

app.post('/api/lab/commands', async (_req, res) => {
  // Демонстрация базовых String и Hash команд.
  await redis.set('demo:string', 'Redis String');
  await redis.hSet('demo:hash', { name: 'Task Manager', type: 'Hash' });
  const value = await redis.get('demo:string');
  const exists = await redis.exists('demo:string');
  const increment = await redis.incr('demo:counter');
  res.json({ GET: value, EXISTS: Boolean(exists), INCR: increment, DEL: 'доступна через Redis CLI' });
});

app.get('/api/stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const handler = (message) => res.write(`data: ${message}\n\n`);
  subscriber.subscribe(eventsChannel, handler);
  reqCleanup();
  function reqCleanup() {
    _req.on('close', async () => {
      try { await subscriber.unsubscribe(eventsChannel, handler); } catch {}
    });
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
