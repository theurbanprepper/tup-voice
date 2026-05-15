'use strict';

// ==================== STATE ====================
const state = {
  view: 'home',        // 'home' | 'project' | 'record' | 'new-project' | 'settings'
  projectId: null,
  sectionIndex: 0,
  recording: false,
  processing: false,
  mediaRecorder: null,
  audioChunks: [],
  timerSeconds: 0,
  timerInterval: null,
  wakeLock: null,
};

// ==================== STORAGE ====================
const storage = {
  getProjects() {
    try { return JSON.parse(localStorage.getItem('tup_projects') || '[]'); }
    catch { return []; }
  },
  saveProjects(projects) {
    localStorage.setItem('tup_projects', JSON.stringify(projects));
  },
  getProject(id) {
    return this.getProjects().find(p => p.id === id) || null;
  },
  updateProject(project) {
    const projects = this.getProjects();
    const i = projects.findIndex(p => p.id === project.id);
    if (i >= 0) projects[i] = project; else projects.push(project);
    this.saveProjects(projects);
  },
  deleteProject(id) {
    this.saveProjects(this.getProjects().filter(p => p.id !== id));
  },
  getApiKey() { return localStorage.getItem('tup_openai_key') || ''; },
  saveApiKey(k) { localStorage.setItem('tup_openai_key', k); },
};

// ==================== AUDIO ====================
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
  state.audioChunks = [];
  state.mediaRecorder = new MediaRecorder(stream, { mimeType });
  state.mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
  };
  state.mediaRecorder.start(1000);
}

function stopRecording() {
  return new Promise(resolve => {
    if (!state.mediaRecorder) return resolve(null);
    const mr = state.mediaRecorder;
    mr.onstop = () => {
      const blob = new Blob(state.audioChunks, { type: mr.mimeType });
      mr.stream.getTracks().forEach(t => t.stop());
      state.mediaRecorder = null;
      resolve(blob);
    };
    mr.stop();
  });
}

// ==================== WAKE LOCK ====================
async function acquireWakeLock() {
  if ('wakeLock' in navigator) {
    try { state.wakeLock = await navigator.wakeLock.request('screen'); }
    catch { /* not available on this device */ }
  }
}

function releaseWakeLock() {
  if (state.wakeLock) { state.wakeLock.release(); state.wakeLock = null; }
}

// ==================== TRANSCRIPTION ====================
async function transcribe(blob) {
  const apiKey = storage.getApiKey();
  if (!apiKey) throw new Error('No API key configured. Go to Settings.');
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', blob, `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  return (await res.json()).text;
}

// ==================== MARKDOWN EXPORT ====================
function generateMarkdown(project) {
  const date = new Date().toISOString().split('T')[0];
  let md = `# ${project.title}\n*Exported: ${date}*\n\n`;
  project.sections.forEach((s, i) => {
    md += `---\n\n## ${i + 1}. ${s.title}\n\n`;
    if (s.bullets?.length) {
      md += `**Prompts:**\n${s.bullets.map(b => `- ${b}`).join('\n')}\n\n`;
    }
    md += `**Transcript:**\n${s.transcript || '*Not yet recorded*'}\n\n`;
  });
  return md;
}

function downloadMarkdown(projectId) {
  const project = storage.getProject(projectId);
  if (!project) return;
  const blob = new Blob([generateMarkdown(project)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `${project.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

// ==================== HELPERS ====================
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function updateTimer() {
  const el = document.getElementById('timer');
  if (el) el.textContent = formatTime(state.timerSeconds);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== RENDER ====================
function render() {
  const views = {
    home: renderHome,
    project: renderProject,
    record: renderRecord,
    'new-project': renderNewProject,
    settings: renderSettings,
  };
  document.getElementById('app').innerHTML = (views[state.view] || renderHome)();
  attachListeners();
}

function renderHome() {
  const projects = storage.getProjects();
  const hasKey = !!storage.getApiKey();
  return `
    <div class="view home-view">
      <header>
        <h1>TUP Voice</h1>
        <button class="icon-btn" id="btn-settings" aria-label="Settings">⚙</button>
      </header>
      ${!hasKey ? `<div class="alert">⚠ Set your OpenAI API key in Settings to enable transcription.</div>` : ''}
      <div class="project-list">
        ${projects.length === 0 ? `<p class="empty">No projects yet.<br>Tap + to add one.</p>` : projects.map(p => {
          const done = p.sections.filter(s => s.transcript).length;
          const total = p.sections.length;
          const pct = total ? Math.round(done / total * 100) : 0;
          return `
            <div class="project-card" data-id="${esc(p.id)}">
              <div class="project-card-top">
                <div>
                  <h2>${esc(p.title)}</h2>
                  <span class="muted">${done}/${total} sections</span>
                </div>
                <button class="del-btn" data-delete="${esc(p.id)}" aria-label="Delete project">✕</button>
              </div>
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            </div>`;
        }).join('')}
      </div>
      <button class="fab" id="btn-add">+ New Project</button>
    </div>`;
}

function renderProject() {
  const project = storage.getProject(state.projectId);
  if (!project) { state.view = 'home'; return renderHome(); }
  const done = project.sections.filter(s => s.transcript).length;
  const total = project.sections.length;
  const next = project.sections.findIndex(s => !s.transcript);
  return `
    <div class="view project-view">
      <header>
        <button class="back-btn" id="btn-back">←</button>
        <h1>${esc(project.title)}</h1>
        <button class="icon-btn" id="btn-download" ${done === 0 ? 'disabled' : ''} title="Download Markdown">↓</button>
      </header>
      <div class="sub-header">${done}/${total} sections complete</div>
      <div class="section-list">
        ${project.sections.map((s, i) => `
          <div class="section-item ${s.transcript ? 'done' : ''}">
            <span class="sec-status">${s.transcript ? '✓' : '○'}</span>
            <div class="sec-info">
              <span class="sec-title">${i + 1}. ${esc(s.title)}</span>
              ${s.transcript ? `<span class="sec-preview">${esc(s.transcript.substring(0, 55))}…</span>` : ''}
            </div>
            <button class="sec-btn" data-go="${i}">${s.transcript ? 'Edit' : 'Record'}</button>
          </div>`).join('')}
      </div>
      ${next >= 0
        ? `<button class="cta-btn" data-go="${next}">▶ ${done === 0 ? 'Start Recording' : 'Continue'}</button>`
        : `<div class="all-done">All sections complete — download your markdown above.</div>`}
    </div>`;
}

function renderRecord() {
  const project = storage.getProject(state.projectId);
  if (!project) { state.view = 'home'; return renderHome(); }
  const section = project.sections[state.sectionIndex];
  if (!section) { state.view = 'project'; return renderProject(); }
  const total = project.sections.length;
  const idx = state.sectionIndex;
  const hasTranscript = !!section.transcript && !state.recording && !state.processing;
  const backDisabled = state.recording || state.processing;

  return `
    <div class="view record-view">
      <header>
        <button class="back-btn" id="btn-back" ${backDisabled ? 'disabled' : ''}>←</button>
        <span class="counter">${idx + 1} / ${total}</span>
      </header>
      <div class="prompt-block">
        <h2>${esc(section.title)}</h2>
        <ul class="bullets">
          ${(section.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}
        </ul>
      </div>
      <div class="record-area">
        ${state.processing ? `
          <div class="processing">
            <div class="spinner"></div>
            <p>Transcribing…</p>
          </div>
        ` : hasTranscript ? `
          <div class="transcript-block">
            <label>Transcript — tap to edit</label>
            <textarea id="transcript-edit" rows="7">${esc(section.transcript)}</textarea>
            <div class="row">
              <button id="btn-save-transcript" class="btn-primary">Save</button>
              <button id="btn-rerecord" class="btn-secondary">Re-record</button>
            </div>
            <div class="row mt">
              ${idx > 0 ? `<button class="btn-secondary" data-go="${idx - 1}">← Prev</button>` : `<span></span>`}
              ${idx < total - 1
                ? `<button class="btn-primary" data-go="${idx + 1}">Next →</button>`
                : `<button class="btn-primary" id="btn-finish">Done ✓</button>`}
            </div>
          </div>
        ` : `
          <div class="record-controls">
            <div id="timer" class="timer">${formatTime(state.timerSeconds)}</div>
            <button id="btn-record" class="record-btn${state.recording ? ' recording' : ''}">
              ${state.recording ? '⏹' : '⏺'}
            </button>
            <p class="hint">${state.recording ? 'Recording… tap to stop' : 'Tap to record'}</p>
            <p class="subhint">Max 10 minutes per section</p>
          </div>
        `}
      </div>
    </div>`;
}

function renderNewProject() {
  return `
    <div class="view form-view">
      <header>
        <button class="back-btn" id="btn-back">←</button>
        <h1>New Project</h1>
      </header>
      <div class="form-body">
        <label>Project Title</label>
        <input type="text" id="proj-title" placeholder="e.g. June Newsletter" />
        <div id="sections-wrap"></div>
        <button id="btn-add-section" class="btn-dashed">+ Add Section</button>
        <button id="btn-save-project" class="cta-btn">Create Project</button>
      </div>
    </div>`;
}

function renderSettings() {
  return `
    <div class="view form-view">
      <header>
        <button class="back-btn" id="btn-back">←</button>
        <h1>Settings</h1>
      </header>
      <div class="form-body">
        <label>OpenAI API Key</label>
        <input type="password" id="api-key" placeholder="sk-…" value="${esc(storage.getApiKey())}" autocomplete="off" />
        <p class="hint">Used for Whisper transcription. Stored only on this device, never sent anywhere except OpenAI.</p>
        <button id="btn-save-key" class="cta-btn">Save Key</button>
      </div>
    </div>`;
}

// ==================== SECTION BUILDER ====================
let sectionCount = 0;

function addSectionField(title = '', bullets = '') {
  sectionCount++;
  const wrap = document.getElementById('sections-wrap');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'section-builder';
  div.innerHTML = `
    <div class="sb-header">
      <label>Section ${sectionCount}</label>
      <button class="del-btn sb-del" type="button">✕</button>
    </div>
    <input type="text" class="sb-name" placeholder="Section title" value="${esc(title)}" />
    <textarea class="sb-bullets" rows="3" placeholder="Bullet points (one per line)">${esc(bullets)}</textarea>`;
  div.querySelector('.sb-del').addEventListener('click', () => div.remove());
  wrap.appendChild(div);
}

function saveNewProject() {
  const title = document.getElementById('proj-title')?.value.trim();
  if (!title) { alert('Please enter a project title.'); return; }
  const sectionEls = document.querySelectorAll('.section-builder');
  const sections = [];
  sectionEls.forEach(el => {
    const name = el.querySelector('.sb-name')?.value.trim();
    const raw = el.querySelector('.sb-bullets')?.value || '';
    const bullets = raw.split('\n').map(b => b.trim()).filter(Boolean);
    if (name) sections.push({ title: name, bullets, transcript: '' });
  });
  if (!sections.length) { alert('Add at least one section.'); return; }
  const project = { id: uid(), title, sections, createdAt: new Date().toISOString() };
  const projects = storage.getProjects();
  projects.push(project);
  storage.saveProjects(projects);
  state.projectId = project.id;
  state.view = 'project';
  render();
}

// ==================== RECORD HANDLER ====================
async function handleRecord() {
  if (state.recording) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    releaseWakeLock();
    const blob = await stopRecording();
    state.recording = false;
    state.processing = true;
    render();
    try {
      const text = await transcribe(blob);
      const project = storage.getProject(state.projectId);
      project.sections[state.sectionIndex].transcript = text;
      storage.updateProject(project);
      state.processing = false;
      render();
    } catch (err) {
      state.processing = false;
      render();
      alert(`Transcription failed: ${err.message}`);
    }
  } else {
    if (!storage.getApiKey()) {
      alert('Add your OpenAI API key in Settings first.');
      return;
    }
    try {
      await startRecording();
      await acquireWakeLock();
      state.recording = true;
      state.timerSeconds = 0;
      render();
      state.timerInterval = setInterval(() => {
        state.timerSeconds++;
        updateTimer();
        if (state.timerSeconds >= 600) handleRecord(); // auto-stop at 10 min
      }, 1000);
    } catch (err) {
      alert(`Microphone error: ${err.message}`);
    }
  }
}

// ==================== LISTENERS ====================
function attachListeners() {
  document.getElementById('btn-back')?.addEventListener('click', () => {
    if (state.recording || state.processing) return;
    if (state.view === 'record') { state.view = 'project'; render(); }
    else { state.view = 'home'; render(); }
  });

  // Home
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    state.view = 'settings'; render();
  });
  document.getElementById('btn-add')?.addEventListener('click', () => {
    sectionCount = 0;
    state.view = 'new-project';
    render();
    addSectionField();
  });
  document.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('[data-delete]')) return;
      state.projectId = card.dataset.id;
      state.view = 'project';
      render();
    });
  });
  document.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const project = storage.getProject(btn.dataset.delete);
      if (confirm(`Delete "${project?.title}"?`)) {
        storage.deleteProject(btn.dataset.delete);
        render();
      }
    });
  });

  // Project
  document.getElementById('btn-download')?.addEventListener('click', () => downloadMarkdown(state.projectId));
  document.querySelectorAll('[data-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sectionIndex = parseInt(btn.dataset.go, 10);
      state.view = 'record';
      render();
    });
  });

  // Record
  document.getElementById('btn-record')?.addEventListener('click', handleRecord);
  document.getElementById('btn-save-transcript')?.addEventListener('click', () => {
    const text = document.getElementById('transcript-edit')?.value || '';
    const project = storage.getProject(state.projectId);
    project.sections[state.sectionIndex].transcript = text;
    storage.updateProject(project);
    render();
  });
  document.getElementById('btn-rerecord')?.addEventListener('click', () => {
    const project = storage.getProject(state.projectId);
    project.sections[state.sectionIndex].transcript = '';
    storage.updateProject(project);
    render();
  });
  document.getElementById('btn-finish')?.addEventListener('click', () => {
    state.view = 'project'; render();
  });

  // New project
  document.getElementById('btn-add-section')?.addEventListener('click', () => addSectionField());
  document.getElementById('btn-save-project')?.addEventListener('click', saveNewProject);

  // Settings
  document.getElementById('btn-save-key')?.addEventListener('click', () => {
    const k = document.getElementById('api-key')?.value.trim();
    if (!k) { alert('Enter a valid API key.'); return; }
    storage.saveApiKey(k);
    alert('API key saved.');
    state.view = 'home';
    render();
  });
}

// ==================== SEED DATA ====================
function seedNewsletter() {
  const newsletter = {
    id: uid(),
    title: 'May Newsletter',
    createdAt: new Date().toISOString(),
    sections: [
      {
        title: 'Personal Opening',
        bullets: [
          'Baby Prepper 3.0 arriving any day now',
          'Life has been busy behind the scenes',
          'Balancing family, work, and channel growth',
          '"A lot has changed recently"',
        ],
        transcript: '',
      },
      {
        title: 'New Studio',
        bullets: [
          'Built a dedicated studio for the channel',
          'Better filming workflow and production quality',
          'More efficient editing and recording setup',
          'Future flagship videos will be filmed there',
          'Excited for what\'s ahead',
        ],
        transcript: '',
      },
      {
        title: 'New Podcast',
        bullets: [
          'Easier way to consume preparedness content',
          'Great for commutes, workouts, and background listening',
          'More conversational format',
          'Expanding beyond YouTube',
        ],
        transcript: '',
      },
      {
        title: '100 Preps Book',
        bullets: [
          'New guide now available',
          'Designed as a practical companion resource',
          'Focused on real-world urban preparedness',
          'Already working on future books/guides',
        ],
        transcript: '',
      },
      {
        title: 'MicroTUP Tool Line',
        bullets: [
          'Creating compact preparedness tools',
          'Focus on practical urban EDC',
          'Early prototypes/testing underway',
          'Newsletter subscribers may get early access',
          'Limited launch discounts + first production run access',
        ],
        transcript: '',
      },
      {
        title: 'Upcoming Video Projects',
        bullets: [
          'Urban Bug Out Bag 3.0',
          'New Altoids Kit',
          'More Power Outage videos',
          'Offline AI preparedness tools',
          'Decentralized emergency communications',
          'More real-world testing content',
        ],
        transcript: '',
      },
      {
        title: 'Membership Portal',
        bullets: [
          'Helps directly support the channel',
          'Behind-the-scenes updates',
          'Exclusive content/community access',
          'Appreciation for longtime supporters',
        ],
        transcript: '',
      },
    ],
  };
  storage.saveProjects([newsletter]);
}

// ==================== INIT ====================
function init() {
  if (storage.getProjects().length === 0) seedNewsletter();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  render();
}

document.addEventListener('DOMContentLoaded', init);
