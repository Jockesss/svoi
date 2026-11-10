'use strict';

// ---------- состояние ----------
// state — то, что сохраняется на сервере (очки, закрытые вопросы, раунд, финал).
// view  — текущий экран, не сохраняется.
let game = null;
let state = null;
let view = { screen: 'intro' };
let menuOpen = false;
const undoStack = [];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const key = (r, t, q) => `${r}:${t}:${q}`;
const STATE_VERSION = 1;

function initState() {
  return {
    version: STATE_VERSION,
    players: game.players.map((name) => ({ name, score: 0 })),
    round: 0,
    closed: {},
    chooser: null,
    final: { removed: [], bets: {}, marks: {}, stage: 'pick' },
  };
}

async function boot() {
  try {
    const r = await fetch('/api/game');
    if (!r.ok) throw new Error(await r.text());
    game = await r.json();
  } catch (e) {
    logEvent(`не удалось загрузить game.json: ${e.message}`, 'error');
    $('main').innerHTML = `<div class="error"><h2>Ошибка в game.json</h2><pre>${esc(e.message)}</pre><p>Исправьте файл и обновите страницу.</p></div>`;
    return;
  }
  try {
    const r = await fetch('/api/state');
    if (r.status === 200) {
      const s = await r.json();
      if (s && s.version === STATE_VERSION) state = s;
    }
  } catch { /* начнём с нуля */ }
  if (!state) state = initState();
  logEvent(`страница открыта: ${inFinal() ? 'финал' : game.rounds[state.round].name}, счёт ${scoreLine()}`);
  view = { screen: inFinal() ? 'final' : 'intro' };
  render();
  if (game.warnings?.length) {
    console.warn(game.warnings.join('\n'));
    toast(`⚠ Не найдено файлов: ${game.warnings.length}. Подробности в консоли и в логе сервера.`, 6000);
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch(() => toast('Не удалось сохранить: сервер недоступен'));
  }, 150);
}

// Любое изменение очков/табло идёт через mutate — так работает «Отменить».
function mutate(fn) {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 300) undoStack.shift();
  fn(state);
  save();
  render();
}

function undo() {
  if (!undoStack.length) return;
  state = JSON.parse(undoStack.pop());
  stopTimer();
  logEvent(`отмена действия, счёт: ${scoreLine()}`);
  view = { screen: inFinal() ? 'final' : 'board' };
  save();
  render();
  toast('Последнее действие отменено');
}

// ---------- помощники ----------
const inFinal = () => state.round >= game.rounds.length;
const curRound = () => game.rounds[state.round];

function roundDone(ri = state.round) {
  return game.rounds[ri].themes.every((t, ti) =>
    t.questions.every((_, qi) => state.closed[key(ri, ti, qi)]));
}

function scoreLine() {
  return state.players.map((p) => `${p.name} ${p.score}`).join(', ');
}

function minValue() {
  const r = curRound();
  if (!r) return 100;
  return Math.min(...r.themes.flatMap((t) => t.questions.map((q) => q.value)));
}

function mediaUrl(p) {
  if (/^https?:\/\//.test(p) || p.startsWith('/')) return p;
  return '/media/' + p.split('/').map(encodeURIComponent).join('/');
}

// Отправляет строку в лог сервера (видно в терминале, где запущен make dev).
function logEvent(msg, level = 'info') {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, msg: String(msg) }),
  }).catch(() => {});
}
window.addEventListener('error', (e) => {
  logEvent(`${e.message} (${e.filename?.split('/').pop()}:${e.lineno}:${e.colno})\n${e.error?.stack ?? ''}`, 'error');
  toast('Ошибка в игре — подробности в терминале сервера');
});
window.addEventListener('unhandledrejection', (e) => {
  logEvent(`unhandled promise: ${e.reason?.stack ?? e.reason}`, 'error');
});
const pname = (i) => state.players[i]?.name ?? `игрок ${i + 1}`;

let toastTimer = null;
function toast(msg, ms = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Перерисовываем часть экрана, только если её HTML изменился —
// иначе бы перезапускались аудио/видео в вопросе при начислении очков.
const parts = {};
function setPart(id, html) {
  if (parts[id] === html) return;
  parts[id] = html;
  $(id).innerHTML = html;
}

// ---------- таймер ----------
const timer = { total: 0, left: 0, running: false, id: null, last: 0 };

function startTimer(sec) {
  stopTimer();
  timer.total = timer.left = sec;
  if (sec && game.settings.autoStartTimer) runTimer();
}
function runTimer() {
  if (timer.running || !timer.total) return;
  if (timer.left <= 0) timer.left = timer.total;
  timer.running = true;
  timer.last = performance.now();
  timer.id = setInterval(tick, 100);
}
function pauseTimer() {
  timer.running = false;
  clearInterval(timer.id);
}
function stopTimer() {
  pauseTimer();
  timer.total = timer.left = 0;
}
function tick() {
  const now = performance.now();
  timer.left = Math.max(0, timer.left - (now - timer.last) / 1000);
  timer.last = now;
  if (timer.left <= 0) {
    pauseTimer();
    beep();
  }
  updateTimerDom();
}
function toggleTimer() {
  if (!timer.total) return;
  timer.running ? pauseTimer() : runTimer();
  updateTimerDom();
}
function updateTimerDom() {
  const el = $('timer');
  if (!el) return;
  const pct = timer.total ? (timer.left / timer.total) * 100 : 0;
  el.querySelector('.timer-fill').style.width = pct + '%';
  el.querySelector('.timer-num').textContent = Math.ceil(timer.left);
  el.classList.toggle('low', timer.left <= 5);
  const btn = $('timer-toggle');
  if (btn) btn.textContent = timer.running ? '⏸' : '▶';
}
function timerHtml() {
  if (!timer.total) return '';
  return `<div class="timer-wrap">
    <div class="timer" id="timer"><div class="timer-fill"></div><span class="timer-num"></span></div>
    <button class="tool" id="timer-toggle" data-a="timer-toggle" title="Пауза / старт (T)"></button>
    <button class="tool" data-a="timer-reset" title="Сначала">↺</button>
  </div>`;
}

let audioCtx = null;

// Звук неправильного ответа: свой файл из settings.wrongSound или встроенный «бззз».
let wrongAudio = null;
function playWrong() {
  const file = game.settings.wrongSound;
  if (file) {
    wrongAudio ??= new Audio(mediaUrl(file));
    wrongAudio.currentTime = 0;
    wrongAudio.play().catch(() => buzz());
    return;
  }
  buzz();
}

function buzz() {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.setValueAtTime(0.25, t + 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    g.connect(audioCtx.destination);
    for (const f of [140, 147]) { // две близкие частоты дают «дребезжащий» гудок
      const o = audioCtx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * 0.8, t + 0.7);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.72);
    }
  } catch { /* без звука */ }
}

function beep() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 440;
    g.gain.setValueAtTime(0.3, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.8);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.8);
  } catch { /* без звука */ }
}

// ---------- отрисовка ----------
function render() {
  setPart('top', renderTop());
  let main = '';
  let bar = '';
  switch (view.screen) {
    case 'intro': main = renderIntro(); bar = renderScoreBar(false); break;
    case 'board': main = renderBoard(); bar = renderScoreBar(true); break;
    case 'question': [main, bar] = renderQuestion(); break;
    case 'final': [main, bar] = renderFinal(); break;
  }
  setPart('main', main);
  setPart('bar', bar);
  setPart('overlay', menuOpen ? renderMenu() : '');
  updateTimerDom();
}

function renderTop() {
  return `<div class="tools">
      <button class="tool" data-a="undo" ${undoStack.length ? '' : 'disabled'} title="Отменить последнее действие (Ctrl+Z)">↶ Отменить</button>
      <button class="tool" data-a="fullscreen" title="Полный экран (F)">⛶</button>
      <button class="tool" data-a="menu" title="Меню">☰</button>
    </div>`;
}

function renderScoreBar(interactive) {
  const step = minValue();
  return `<div class="players">${state.players.map((p, i) => `
    <div class="player ${state.chooser === i ? 'chooser' : ''}">
      <div class="pname" ${interactive ? `data-a="chooser" data-p="${i}" title="Клик — выбирает этот игрок. Двойной клик — переименовать"` : ''}>${esc(p.name)}</div>
      <div class="pscore ${p.score < 0 ? 'neg' : ''}" ${interactive ? `data-a="setscore" data-p="${i}" title="Клик — ввести счёт вручную"` : ''}>${p.score}</div>
      ${interactive ? `<div class="adj">
        <button data-a="adj" data-p="${i}" data-d="${-step}">−${step}</button>
        <button data-a="adj" data-p="${i}" data-d="${step}">+${step}</button>
      </div>` : ''}
    </div>`).join('')}</div>`;
}

function renderIntro() {
  const r = curRound();
  return `<div class="center intro">
    <h1>${esc(r.name)}</h1>
    <ul class="tiles">${r.themes.map((t, i) => `<li style="--i:${i}">${esc(t.name)}</li>`).join('')}</ul>
    <button class="big" data-a="start-round">Начать</button>
  </div>`;
}

function renderBoard() {
  const r = curRound();
  const ri = state.round;
  const cols = Math.max(...r.themes.map((t) => t.questions.length));
  let html = `<div class="board" style="--cols:${cols};--rows:${r.themes.length}">`;
  r.themes.forEach((t, ti) => {
    html += `<div class="theme">${esc(t.name)}</div>`;
    for (let qi = 0; qi < cols; qi++) {
      const q = t.questions[qi];
      html += !q || state.closed[key(ri, ti, qi)]
        ? '<div class="cell empty"></div>'
        : `<button class="cell" data-a="open" data-t="${ti}" data-q="${qi}">${q.value}</button>`;
    }
  });
  html += '</div>';

  if (roundDone()) {
    const next = state.round + 1 < game.rounds.length ? 'Следующий раунд' : (game.final ? 'К финалу' : 'Итоги');
    return html + `<div class="board-info done">Раунд завершён! <button class="big" data-a="next-round">${next} →</button></div>`;
  }
  const who = state.chooser != null
    ? `Выбирает: <b>${esc(state.players[state.chooser].name)}</b>`
    : 'Кликните по имени игрока, чтобы назначить выбирающего';
  return html + `<div class="board-info">${who}</div>`;
}

function renderContent(c) {
  const hasMedia = c.image || c.video;
  let h = `<div class="content ${hasMedia ? 'has-media' : ''}">`;
  if (c.text) h += `<div class="qtext">${esc(c.text)}</div>`;
  if (c.image) h += `<div class="media"><img src="${esc(mediaUrl(c.image))}" alt=""></div>`;
  if (c.video) h += `<div class="media"><video src="${esc(mediaUrl(c.video))}" controls></video></div>`;
  if (c.audio) h += `<audio src="${esc(mediaUrl(c.audio))}" controls autoplay></audio>`;
  return h + '</div>';
}

function renderAnswer(c) {
  let h = `<div class="content answer ${c.answerImage ? 'has-media' : ''}">`;
  if (c.answer) h += `<div class="qtext">${esc(c.answer)}</div>`;
  if (c.answerImage) h += `<div class="media"><img src="${esc(mediaUrl(c.answerImage))}" alt=""></div>`;
  return h + '</div>';
}

function currentQuestion() {
  const th = curRound().themes[view.t];
  return { th, q: th.questions[view.q] };
}

function questionValue(q) {
  return q.type === 'auction' ? view.bet : q.value;
}

function renderQuestion() {
  const { th, q } = currentQuestion();
  const themeName = q.type === 'cat' && q.catTheme ? q.catTheme : th.name;
  const val = questionValue(q);
  let main = `<div class="qhead"><span class="qtheme">${esc(themeName)}</span><span class="qvalue">${val}</span></div>`;
  let bar;

  switch (view.stage) {
    case 'cat':
      main += `<div class="splash">
        <div class="splash-icon">🐱</div>
        <h1>Кот в мешке!</h1>
        <p>Выбирающий отдаёт вопрос другому игроку.${q.catTheme ? `<br>Тема: <b>${esc(q.catTheme)}</b>, стоимость <b>${q.value}</b>` : ''}</p>
        <p class="hint">Кликните, кому достаётся вопрос ↓</p>
      </div>`;
      bar = pickBar('cat-target');
      break;
    case 'auction':
      main += `<div class="splash">
        <div class="splash-icon">💰</div>
        <h1>Аукцион!</h1>
        <p>Игроки торгуются за вопрос. Минимальная ставка — ${q.value}.</p>
        <label class="bet-row">Ставка победителя <input id="bet" type="number" min="${q.value}" step="100" value="${view.bet}"></label>
        <p class="hint">Кликните, кто выиграл аукцион ↓</p>
      </div>`;
      bar = pickBar('auction-target');
      break;
    case 'question':
      main += renderContent(q) + timerHtml() + `<div class="actions">
        <button class="ghost" data-a="back">← К табло (вопрос останется)</button>
        <button class="big" data-a="show-answer">Показать ответ</button>
      </div>`;
      bar = answerBar(val);
      break;
    case 'answer':
      main += renderAnswer(q) + `<div class="actions">
        <button class="big" data-a="close-q">К табло</button>
      </div>`;
      bar = renderScoreBar(false);
      break;
  }
  return [main, bar];
}

function pickBar(action) {
  return `<div class="players">${state.players.map((p, i) => `
    <button class="player pickable ${state.chooser === i ? 'chooser' : ''}" data-a="${action}" data-p="${i}">
      <div class="pname">${esc(p.name)}</div>
      <div class="pscore ${p.score < 0 ? 'neg' : ''}">${p.score}</div>
    </button>`).join('')}</div>`;
}

function answerBar(val) {
  return `<div class="players">${state.players.map((p, i) => {
    const active = (view.target == null || view.target === i) && !view.tried[i];
    return `<div class="player ${active ? '' : 'dim'} ${view.target === i ? 'chooser' : ''}">
      <div class="pname">${esc(p.name)}</div>
      <div class="pscore ${p.score < 0 ? 'neg' : ''}">${p.score}</div>
      <div class="adj">${active ? `
        <button class="ok" data-a="right" data-p="${i}" title="Верно: +${val}">✓</button>
        <button class="bad" data-a="wrong" data-p="${i}" title="Неверно: −${val}">✗</button>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ---------- финал ----------
function finalChosen() {
  const remaining = game.final.themes.map((_, i) => i).filter((i) => !state.final.removed.includes(i));
  return remaining.length === 1 ? remaining[0] : null;
}

function renderFinal() {
  const F = game.final;
  const f = state.final;
  if (!F || f.stage === 'done') return [renderWinners(), ''];
  const chosen = finalChosen();
  const theme = chosen != null ? F.themes[chosen] : null;

  switch (f.stage) {
    case 'pick': {
      const left = F.themes.length - f.removed.length;
      return [`<div class="center">
        <h1>Финал</h1>
        <p class="hint">${left > 1 ? 'Игроки по очереди убирают темы. Кликните по теме, чтобы убрать её.' : 'Тема финала выбрана!'}</p>
        <div class="tiles">${F.themes.map((t, i) => {
          const removed = f.removed.includes(i);
          return `<button class="ftheme ${removed ? 'removed' : ''} ${i === chosen ? 'chosen' : ''}" data-a="final-remove" data-i="${i}" ${removed || left <= 1 ? 'disabled' : ''}>${esc(t.name)}</button>`;
        }).join('')}</div>
        ${left === 1 ? '<button class="big" data-a="final-bets">К ставкам →</button>' : ''}
      </div>`, renderScoreBar(false)];
    }
    case 'bets':
      return [`<div class="center">
        <h1>Тема: ${esc(theme.name)}</h1>
        <p class="hint">Игроки пишут ставки на бумажке, ведущий вводит их сюда — на экране они скрыты.<br>Ставка — от 0 до текущего счёта. У кого счёт 0 или меньше, играет на 0.</p>
        <div class="bets">${state.players.map((p, i) => {
          const max = Math.max(p.score, 0);
          return `<label class="bet-card">
            <span class="pname">${esc(p.name)}</span>
            <span class="pscore ${p.score < 0 ? 'neg' : ''}">${p.score}</span>
            <input type="password" inputmode="numeric" autocomplete="off" data-bet="${i}" placeholder="${max ? `0–${max}` : '0'}" value="${esc(f.bets[i] ?? '')}" ${max === 0 ? 'disabled' : ''}>
          </label>`;
        }).join('')}</div>
        <button class="big" data-a="final-question">Показать вопрос →</button>
      </div>`, ''];
    case 'question':
      return [`<div class="qhead"><span class="qtheme">Финал · ${esc(theme.name)}</span></div>`
        + renderContent(theme) + timerHtml()
        + '<div class="actions"><button class="big" data-a="final-answer">Показать ответ</button></div>',
        renderScoreBar(false)];
    case 'answer':
      return [`<div class="qhead"><span class="qtheme">Финал · ${esc(theme.name)}</span></div>`
        + renderAnswer(theme)
        + '<div class="actions"><p class="hint">Отметьте, кто ответил верно ↓</p><button class="big" data-a="final-finish">Подвести итоги 🏆</button></div>',
        finalMarksBar()];
  }
  return ['', ''];
}

function finalMarksBar() {
  const f = state.final;
  return `<div class="players">${state.players.map((p, i) => {
    const m = f.marks[i];
    return `<div class="player">
      <div class="pname">${esc(p.name)}</div>
      <div class="pscore ${p.score < 0 ? 'neg' : ''}">${p.score}</div>
      <div class="bet-reveal">ставка ${betOf(i)}</div>
      <div class="adj">
        <button class="ok ${m === 'wrong' ? 'off' : ''}" data-a="final-mark" data-p="${i}" data-m="right">✓</button>
        <button class="bad ${m === 'right' ? 'off' : ''}" data-a="final-mark" data-p="${i}" data-m="wrong">✗</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function betOf(i) {
  const n = parseInt(state.final.bets[i], 10);
  return Number.isFinite(n) ? n : 0;
}

function renderWinners() {
  const sorted = state.players.map((p) => ({ ...p })).sort((a, b) => b.score - a.score);
  const top = sorted[0]?.score;
  const winners = sorted.filter((p) => p.score === top).map((p) => esc(p.name)).join(', ');
  return `<div class="center winners">
    <div class="splash-icon">🏆</div>
    <h1>${winners}</h1>
    <ol class="leader">${sorted.map((p) => `<li class="${p.score === top ? 'win' : ''}"><span>${esc(p.name)}</span><b>${p.score}</b></li>`).join('')}</ol>
  </div>`;
}

function renderMenu() {
  return `<div class="modal-bg" data-a="menu-close"><div class="modal" data-a="noop">
    <h2>Меню</h2>
    <div class="menu-list">
      ${game.rounds.map((r, i) => `<button data-a="goto-round" data-i="${i}" class="${state.round === i ? 'active' : ''}">${esc(r.name)} ${roundDone(i) ? '✓' : ''}</button>`).join('')}
      ${game.final ? `<button data-a="goto-final" class="${inFinal() ? 'active' : ''}">Финал</button>` : ''}
    </div>
    <p class="hint">
      <b>Пробел</b> — показать ответ / к табло · <b>T</b> — таймер · <b>Ctrl+Z</b> — отменить · <b>F</b> — полный экран · <b>Esc</b> — назад<br>
      На табло: клик по имени — кто выбирает, двойной клик — переименовать, клик по счёту — ввести вручную.
    </p>
    <button class="danger" data-a="reset">Сбросить игру</button>
    <button data-a="menu-close">Закрыть</button>
  </div></div>`;
}

// ---------- действия ----------
function openQuestion(ti, qi) {
  const q = curRound().themes[ti].questions[qi];
  view = { screen: 'question', t: ti, q: qi, stage: null, target: null, bet: q.value, tried: {} };
  const kind = q.type === 'cat' ? ' [кот в мешке]' : q.type === 'auction' ? ' [аукцион]' : '';
  logEvent(`открыт вопрос: «${curRound().themes[ti].name}» за ${q.value}${kind}`);
  goStage(q.type === 'cat' ? 'cat' : q.type === 'auction' ? 'auction' : 'question');
}

function goStage(stage) {
  view.stage = stage;
  if (stage === 'question') startTimer(game.settings.timer);
  else stopTimer();
  render();
}

function closeQuestion() {
  const k = key(state.round, view.t, view.q);
  stopTimer();
  view = { screen: 'board' };
  mutate((s) => { s.closed[k] = true; });
}

function scoreRight(i) {
  const { q } = currentQuestion();
  const val = questionValue(q);
  view.tried[i] = true;
  view.stage = 'answer';
  stopTimer();
  mutate((s) => { s.players[i].score += val; s.chooser = i; });
  logEvent(`✓ ${pname(i)} +${val} → ${state.players[i].score}`);
}

function scoreWrong(i) {
  const { q } = currentQuestion();
  const val = questionValue(q);
  view.tried[i] = true;
  const everyoneTried = state.players.every((_, j) => view.tried[j]);
  if (view.target != null || everyoneTried) {
    view.stage = 'answer';
    stopTimer();
  }
  playWrong();
  mutate((s) => { s.players[i].score -= val; });
  logEvent(`✗ ${pname(i)} −${val} → ${state.players[i].score}`);
}

function nextRound() {
  view = { screen: state.round + 1 >= game.rounds.length ? 'final' : 'intro' };
  mutate((s) => { s.round++; });
  logEvent(`переход: ${inFinal() ? 'финал' : game.rounds[state.round].name}, счёт: ${scoreLine()}`);
}

function startFinalQuestion() {
  const f = state.final;
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const max = Math.max(p.score, 0);
    if (max === 0) { f.bets[i] = 0; continue; }
    const raw = f.bets[i];
    const n = parseInt(raw, 10);
    if (raw === undefined || raw === '' || !Number.isFinite(n)) {
      toast(`Введите ставку игрока ${p.name}`);
      return;
    }
    if (n < 0 || n > max) {
      toast(`Ставка игрока ${p.name} должна быть от 0 до ${max}`);
      return;
    }
  }
  startTimer(game.settings.finalTimer);
  mutate((s) => { s.final.stage = 'question'; });
}

function finishFinal() {
  const f = state.final;
  const missing = state.players.filter((_, i) => !f.marks[i]);
  if (missing.length) {
    toast(`Отметьте ✓ или ✗: ${missing.map((p) => p.name).join(', ')}`);
    return;
  }
  mutate((s) => {
    s.players.forEach((p, i) => { p.score += (s.final.marks[i] === 'right' ? 1 : -1) * betOf(i); });
    s.final.stage = 'done';
  });
  logEvent(`итоги финала: ${scoreLine()}`);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

const actions = {
  undo,
  fullscreen: toggleFullscreen,
  menu: () => { menuOpen = true; render(); },
  'menu-close': () => { menuOpen = false; render(); },
  noop: () => {},
  'start-round': () => { view = { screen: 'board' }; render(); },
  'next-round': nextRound,
  open: (el) => openQuestion(+el.dataset.t, +el.dataset.q),
  chooser: (el) => {
    const p = +el.dataset.p;
    if (state.chooser !== p) mutate((s) => { s.chooser = p; });
  },
  setscore: (el) => {
    const p = +el.dataset.p;
    const v = prompt(`Счёт игрока ${state.players[p].name}:`, state.players[p].score);
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return toast('Нужно целое число');
    mutate((s) => { s.players[p].score = n; });
  },
  adj: (el) => mutate((s) => { s.players[+el.dataset.p].score += +el.dataset.d; }),
  'cat-target': (el) => {
    view.target = +el.dataset.p;
    logEvent(`кот в мешке отдан: ${pname(view.target)}`);
    goStage('question');
  },
  'auction-target': (el) => {
    const { q } = currentQuestion();
    const bet = parseInt($('bet')?.value, 10);
    if (!Number.isFinite(bet) || bet < q.value) return toast(`Ставка должна быть не меньше ${q.value}`);
    view.bet = bet;
    view.target = +el.dataset.p;
    logEvent(`аукцион выиграл ${pname(view.target)}, ставка ${bet}`);
    goStage('question');
  },
  right: (el) => scoreRight(+el.dataset.p),
  wrong: (el) => scoreWrong(+el.dataset.p),
  'show-answer': () => goStage('answer'),
  'close-q': closeQuestion,
  back: () => { stopTimer(); view = { screen: 'board' }; render(); },
  'timer-toggle': toggleTimer,
  'timer-reset': () => { pauseTimer(); timer.left = timer.total; updateTimerDom(); },
  'final-remove': (el) => mutate((s) => { s.final.removed.push(+el.dataset.i); }),
  'final-bets': () => mutate((s) => { s.final.stage = 'bets'; }),
  'final-question': startFinalQuestion,
  'final-answer': () => { stopTimer(); mutate((s) => { s.final.stage = 'answer'; }); },
  'final-mark': (el) => {
    if (el.dataset.m === 'wrong' && state.final.marks[+el.dataset.p] !== 'wrong') playWrong();
    mutate((s) => { s.final.marks[+el.dataset.p] = el.dataset.m; });
  },
  'final-finish': finishFinal,
  'goto-round': (el) => {
    menuOpen = false;
    stopTimer();
    view = { screen: 'intro' };
    mutate((s) => { s.round = +el.dataset.i; });
  },
  'goto-final': () => {
    menuOpen = false;
    stopTimer();
    view = { screen: 'final' };
    mutate((s) => { s.round = game.rounds.length; });
  },
  reset: () => {
    if (!confirm('Сбросить все очки, открытые вопросы и финал? (можно будет отменить)')) return;
    undoStack.push(JSON.stringify(state));
    state = initState();
    logEvent('игра сброшена');
    menuOpen = false;
    stopTimer();
    view = { screen: 'intro' };
    save();
    render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  actions[el.dataset.a]?.(el, e);
  // снимаем фокус, чтобы Пробел не «нажимал» кнопку повторно
  if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
});

document.addEventListener('dblclick', (e) => {
  const el = e.target.closest('[data-a="chooser"]');
  if (!el) return;
  const p = +el.dataset.p;
  const name = prompt('Имя игрока:', state.players[p].name);
  if (name && name.trim()) mutate((s) => { s.players[p].name = name.trim(); });
});

document.addEventListener('input', (e) => {
  const i = e.target.dataset?.bet;
  if (i === undefined) return;
  state.final.bets[i] = e.target.value.trim();
  save();
});

document.addEventListener('keydown', (e) => {
  if (!game || !state) return;
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (menuOpen) return actions['menu-close']();
    if (typing) return document.activeElement.blur();
    if (view.screen === 'question' && view.stage === 'question') return actions.back();
    return;
  }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return undo();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'f' || k === 'а') return toggleFullscreen();
  if (k === 't' || k === 'е') return toggleTimer();
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (menuOpen) return;
    if (view.screen === 'intro') return actions['start-round']();
    if (view.screen === 'question' && view.stage === 'question') return actions['show-answer']();
    if (view.screen === 'question' && view.stage === 'answer') return closeQuestion();
    if (view.screen === 'final' && state.final.stage === 'question') return actions['final-answer']();
  }
});

boot();
