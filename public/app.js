const $ = (selector) => document.querySelector(selector);
const visitorId = localStorage.getItem('visitorId') || crypto.randomUUID();
localStorage.setItem('visitorId', visitorId);

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Ошибка');
  return data;
}

function statusText(status) {
  return { pending: 'Ожидает', processing: 'В работе', completed: 'Готово', error: 'Ошибка' }[status] || status;
}

async function loadStats() {
  const data = await request('/api/stats');
  $('#stats').innerHTML = `
    <div class="stat">Всего<strong>${data.total}</strong></div>
    <div class="stat">Ожидают<strong>${data.pending}</strong></div>
    <div class="stat">В работе<strong>${data.processing}</strong></div>
    <div class="stat">Готово<strong>${data.completed}</strong></div>
    <div class="stat">Посетители<strong>${data.visitors}</strong></div>
    <div class="stat">Кеш<strong>${data.cache}</strong></div>`;
}

async function loadTasks() {
  const tasks = await request('/api/tasks');
  $('#tasks').innerHTML = tasks.length ? tasks.map((task) => `
    <div class="task">
      <div>
        <div class="task-title">${escapeHtml(task.title)} <span class="badge">${statusText(task.status)}</span></div>
        <div class="meta">Приоритет: ${task.priority} · Теги: ${escapeHtml(task.tags.join(', ') || 'нет')}</div>
      </div>
      <div class="actions">
        ${task.status !== 'completed' ? `<button onclick="completeTask('${task.id}')">Готово</button>` : ''}
        <button class="danger" onclick="deleteTask('${task.id}')">Удалить</button>
      </div>
    </div>`).join('') : '<p>Задач пока нет.</p>';
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }

async function reload() { await Promise.all([loadStats(), loadTasks()]); }

$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const tags = $('#tags').value.split(',').map((tag) => tag.trim()).filter(Boolean);
  await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: $('#title').value, priority: $('#priority').value, tags }) });
  event.target.reset();
  $('#priority').value = '2';
  await reload();
});

window.completeTask = async (id) => { await request(`/api/tasks/${id}/complete`, { method: 'POST' }); await reload(); };
window.deleteTask = async (id) => { await request(`/api/tasks/${id}`, { method: 'DELETE' }); await reload(); };

$('#refresh').addEventListener('click', reload);
$('#labRefresh').addEventListener('click', async () => {
  await request('/api/lab/commands', { method: 'POST' });
  await request('/api/lab/ttl', { method: 'POST' });
  const data = await request('/api/lab');
  $('#lab').innerHTML = Object.entries(data).map(([key, value]) => `<div class="lab-item"><strong>${key}</strong><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></div>`).join('');
});

await request('/api/visitor', { method: 'POST', body: JSON.stringify({ visitorId }) });
await reload();

const stream = new EventSource('/api/stream');
stream.onmessage = () => reload();
