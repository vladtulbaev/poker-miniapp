/* Покер — Telegram Mini App. Тонкий клиент: всё состояние приходит с сервера по WebSocket. */
(() => {
  'use strict';

  const BOT_USERNAME = 'cashpoker_bot';
  const qs = new URLSearchParams(location.search);
  const WS_URL = qs.get('ws') || (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'ws://localhost:8765' : 'wss://217-144-186-195.sslip.io');

  // ---------- Telegram ----------
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTG = !!(tg && tg.initData);
  if (tg) {
    try {
      tg.ready(); tg.expand();
      tg.setHeaderColor && tg.setHeaderColor('#000000');
      tg.setBackgroundColor && tg.setBackgroundColor('#000000');
      tg.setBottomBarColor && tg.setBottomBarColor('#000000');
      tg.disableVerticalSwipes && tg.disableVerticalSwipes();
      if (inTG) {
        tg.BackButton.onClick(onBack);
        if (tg.SettingsButton) { tg.SettingsButton.show(); tg.SettingsButton.onClick(() => { if (screen === 'table') openSheet('sheet-menu'); else openSheet('sheet-avatar'); }); }
      }
    } catch (e) { /* ignore */ }
  }
  const haptic = (t) => { try { t === 'sel' ? tg.HapticFeedback.selectionChanged() : tg.HapticFeedback.impactOccurred(t || 'light'); } catch (e) {} };

  // ---------- константы ----------
  const HAND_NAMES = ['Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];
  const RANK_CH = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const SUIT_SVG = {
    h: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    d: '<svg viewBox="0 0 24 24"><path d="M12 2.8 20.6 12 12 21.2 3.4 12z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>',
    s: '<svg viewBox="0 0 24 24"><path d="M12 2C12 2 4 8.6 4 13.4a4.1 4.1 0 0 0 6.9 3c-.3 1.8-1.3 3.4-2.9 4.6h8c-1.6-1.2-2.6-2.8-2.9-4.6a4.1 4.1 0 0 0 6.9-3C20 8.6 12 2 12 2z"/></svg>',
    c: '<svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="4.2"/><circle cx="6.6" cy="13.6" r="4.2"/><circle cx="17.4" cy="13.6" r="4.2"/><path d="M10.4 12h3.2c0 3.4 1 6.3 2.6 9H7.8c1.6-2.7 2.6-5.6 2.6-9z"/></svg>'
  };
  const AVATARS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
  const avatarSrc = (a) => `assets/${AVATARS.includes(a) ? a : 'm5'}.png`;
  const rankCh = (r) => RANK_CH[r] || String(r);
  const isRed = (s) => s === 'h' || s === 'd';

  // ---------- оценка комбинации (для плитки игрока) ----------
  function groups(cards) {
    const cnt = {}; cards.forEach(c => cnt[c[0]] = (cnt[c[0]] || 0) + 1);
    return Object.keys(cnt).map(r => [cnt[r], +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  }
  function eval5(c) {
    const rs = c.map(x => x[0]).sort((a, b) => b - a);
    const flush = c.every(x => x[1] === c[0][1]);
    let straight = 0;
    if (new Set(rs).size === 5) { if (rs[0] - rs[4] === 4) straight = rs[0]; else if (rs[0] === 14 && rs[1] === 5 && rs[4] === 2) straight = 5; }
    if (straight && flush) return [8, straight];
    const g = groups(c), flat = g.map(x => x[1]);
    if (g[0][0] === 4) return [7, ...flat];
    if (g[0][0] === 3 && g[1][0] === 2) return [6, ...flat];
    if (flush) return [5, ...rs];
    if (straight) return [4, straight];
    if (g[0][0] === 3) return [3, ...flat];
    if (g[0][0] === 2 && g[1][0] === 2) return [2, ...flat];
    if (g[0][0] === 2) return [1, ...flat];
    return [0, ...rs];
  }
  function combos(arr, k) { const out = []; (function rec(s, cur) { if (cur.length === k) { out.push(cur.slice()); return; } for (let i = s; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); } })(0, []); return out; }
  const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
  function evalBest(cards) {
    if (cards.length < 5) {
      const g = groups(cards), flat = g.map(x => x[1]);
      if (!g.length) return [0];
      if (g[0][0] === 4) return [7, ...flat];
      if (g[0][0] === 3) return [3, ...flat];
      if (g[0][0] === 2 && g[1] && g[1][0] === 2) return [2, ...flat];
      if (g[0][0] === 2) return [1, ...flat];
      return [0, ...flat];
    }
    let best = null;
    for (const c of combos(cards, 5)) { const s = eval5(c); if (!best || cmp(s, best) > 0) best = s; }
    return best;
  }
  const handName = (s) => (s[0] === 8 && s[1] === 14) ? 'Флеш-рояль' : HAND_NAMES[s[0]];

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const screens = { home: $('screen-home'), lobby: $('screen-lobby'), table: $('app') };
  const seatsEl = $('seats'), boardEl = $('board'), potEl = $('pot'), statusEl = $('status'), actionsEl = $('actions');
  const handEl = $('hand'), holeEls = [$('hole0'), $('hole1')];
  const btnCall = $('btn-call'), btnRaise = $('btn-raise'), btnMore = $('btn-more');
  const timerBar = $('timerbar').firstElementChild;
  if (inTG) $('topbar').hidden = true;

  let screen = 'home';
  let ME = { id: null, name: '…', avatar: 'm5' };
  let S = null;           // состояние комнаты с сервера
  let pendingRoom = (qs.get('room') || (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '').toUpperCase();

  function showScreen(name) {
    screen = name;
    Object.entries(screens).forEach(([k, el]) => el.hidden = k !== name);
    if (inTG) { if (name === 'home') tg.BackButton.hide(); else tg.BackButton.show(); }
    if (name !== 'table') closeSheets();
  }
  function onBack() {
    if (screen === 'table') openSheet('sheet-menu');
    else if (screen === 'lobby') send({ t: 'leave' });
    else if (inTG) tg.close();
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 2600);
  }

  // ---------- WebSocket ----------
  let ws = null, wsTimer = null, backoff = 800;
  function devIdentity() {
    let id = null;
    if (qs.get('dev')) return { id: qs.get('dev'), name: qs.get('name') || ('Гость ' + qs.get('dev')) };
    try { id = localStorage.getItem('poker.devid'); if (!id) { id = Math.random().toString(36).slice(2, 12); localStorage.setItem('poker.devid', id); } } catch (e) { id = 'x' + Date.now(); }
    return { id, name: qs.get('name') || ('Гость ' + id.slice(0, 3)) };
  }
  function connect() {
    clearTimeout(wsTimer);
    $('conn').textContent = 'Подключение…';
    try { ws = new WebSocket(WS_URL); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => {
      backoff = 800; $('conn').textContent = '';
      const auth = { t: 'auth', initData: (tg && tg.initData) || '', dev: devIdentity() };
      if (pendingRoom) { auth.room = pendingRoom; pendingRoom = ''; }
      ws.send(JSON.stringify(auth));
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
    ws.onclose = () => { $('conn').textContent = 'Нет связи с сервером, переподключаюсь…'; scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  function scheduleReconnect() { clearTimeout(wsTimer); wsTimer = setTimeout(connect, backoff); backoff = Math.min(backoff * 1.6, 8000); }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); else toast('Нет связи с сервером'); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (!ws || ws.readyState !== 1)) connect(); });

  function onMessage(m) {
    if (m.t === 'me') { ME = { id: m.id, name: m.name, avatar: m.avatar }; renderMeChip(); return; }
    if (m.t === 'home') { S = null; showScreen('home'); return; }
    if (m.t === 'error') { toast(m.msg || 'Ошибка'); if (m.fatal) $('conn').textContent = m.msg; return; }
    if (m.t === 'state') { applyState(m); return; }
  }

  // ---------- главная ----------
  function renderMeChip() {
    $('home-avatar').src = avatarSrc(ME.avatar); $('home-name').textContent = ME.name;
    $('me-avatar').src = avatarSrc(ME.avatar);
  }
  $('home-create').addEventListener('click', () => { haptic('light'); send({ t: 'create', bots: 0 }); });
  $('home-bots').addEventListener('click', () => { haptic('light'); send({ t: 'create', bots: 4, autostart: true }); });
  $('home-join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('home-code').value.trim().toUpperCase();
    if (code.length < 4) { toast('Введи код из 4 символов'); return; }
    send({ t: 'join', room: code });
  });
  $('home-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
  $('home-avatar-btn').addEventListener('click', () => openSheet('sheet-avatar'));

  // ---------- аватары ----------
  const grid = $('avatar-grid');
  AVATARS.forEach(a => {
    const b = document.createElement('button'); b.className = 'av'; b.dataset.a = a;
    b.innerHTML = `<img src="${avatarSrc(a)}" alt="">`;
    b.addEventListener('click', () => { haptic('sel'); send({ t: 'avatar', avatar: a }); ME.avatar = a; renderMeChip(); markAvatar(); closeSheets(); });
    grid.appendChild(b);
  });
  function markAvatar() { grid.querySelectorAll('.av').forEach(b => b.classList.toggle('sel', b.dataset.a === ME.avatar)); }
  $('avatar-close').addEventListener('click', closeSheets);

  // ---------- лобби ----------
  const isHost = () => S && S.host === ME.id;
  function renderLobby() {
    $('lobby-code').textContent = S.code;
    const list = $('lobby-list'); list.innerHTML = '';
    S.players.forEach(p => {
      const row = document.createElement('div'); row.className = 'lobby-row' + (p.online || p.bot ? '' : ' off');
      row.innerHTML = `<img src="${avatarSrc(p.avatar)}" alt=""><div class="lr-name">${esc(p.name)}${p.id === ME.id ? ' <span class="you">(ты)</span>' : ''}</div><div class="lr-tag">${p.id === S.host ? 'хост' : (p.bot ? 'бот' : (p.online ? '' : 'офлайн'))}</div>`;
      list.appendChild(row);
    });
    for (let i = S.players.length; i < 5; i++) { const row = document.createElement('div'); row.className = 'lobby-row empty'; row.innerHTML = '<div class="lr-dot"></div><div class="lr-name">свободно</div>'; list.appendChild(row); }
    const host = isHost(), n = S.players.length;
    $('lobby-host-row').hidden = !host;
    $('lobby-start').hidden = !host;
    $('lobby-wait').hidden = host;
    $('lobby-start').disabled = n < 2;
    $('lobby-start').textContent = n < 2 ? 'Нужно минимум 2 игрока' : 'Начать игру';
    $('lobby-addbot').disabled = n >= 5;
    $('lobby-removebot').disabled = !S.players.some(p => p.bot);
    $('lobby-hint').textContent = n < 2 ? 'Позови друзей — минимум 2 игрока' : `Игроков: ${n} из 5`;
  }
  $('lobby-back').addEventListener('click', () => send({ t: 'leave' }));
  $('lobby-invite').addEventListener('click', invite);
  $('lobby-addbot').addEventListener('click', () => send({ t: 'add_bot' }));
  $('lobby-removebot').addEventListener('click', () => send({ t: 'remove_bot' }));
  $('lobby-start').addEventListener('click', () => { haptic('medium'); send({ t: 'start' }); });

  function invite() {
    if (!S) return;
    const link = `https://t.me/${BOT_USERNAME}?start=${S.code}`;
    const text = `Залетай в покер, стол ${S.code}`;
    haptic('light');
    if (inTG) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
    else if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast('Ссылка скопирована: ' + link)).catch(() => toast(link));
    else toast(link);
  }

  // ---------- стол: применение состояния ----------
  let seatEls = new Map();   // id -> el
  let seatOrder = '';
  let boardShown = 0, holeKey = '', lastCode = '';

  function applyState(st) {
    S = st;
    if (st.code !== lastCode) { lastCode = st.code; boardShown = 0; holeKey = ''; seatOrder = ''; }
    if (st.phase === 'lobby') { showScreen('lobby'); renderLobby(); return; }
    if (screen !== 'table') { showScreen('table'); boardShown = 0; holeKey = ''; seatOrder = ''; }
    renderAll();
  }

  const me = () => (S && S.you >= 0) ? S.players[S.you] : null;
  const myTurn = () => S && S.toAct === S.you && S.you >= 0 && !!S.deadline;
  const toCallMe = () => { const p = me(); return Math.min(S.currentBet - p.bet, p.stack); };
  const minRaiseTo = () => { const p = me(); return Math.min(S.currentBet + S.minRaise, p.stack + p.bet); };
  const maxRaiseTo = () => { const p = me(); return p.stack + p.bet; };

  function cardHTML(c, extra) {
    const [r, s] = c; const wide = r === 10;
    return `<div class="card ${isRed(s) ? 'red' : ''} ${extra || ''}"><div class="rank ${wide ? 'wide' : ''}">${rankCh(r)}</div><div class="suit">${SUIT_SVG[s]}</div></div>`;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  function renderSeats() {
    const order = S.players.map(p => p.id).join('|');
    if (order !== seatOrder) {
      seatOrder = order; seatsEl.innerHTML = ''; seatEls = new Map();
      seatsEl.style.gridTemplateColumns = `repeat(${S.players.length}, 20%)`;
      S.players.forEach(p => {
        const el = document.createElement('div'); el.className = 'seat';
        el.innerHTML = `<div class="avatar-wrap"><img class="avatar" src="${avatarSrc(p.avatar)}" alt=""><div class="dealer">D</div></div>
          <div class="name">${esc(p.name)}</div><div class="stack">${p.stack}</div>
          <div class="bet-wrap"><div class="bet"></div><div class="mini-cards"></div></div>`;
        seatsEl.appendChild(el); seatEls.set(p.id, el);
      });
    }
    S.players.forEach((p, i) => {
      const el = seatEls.get(p.id);
      const img = el.querySelector('.avatar'); const src = avatarSrc(p.avatar); if (!img.src.endsWith(src)) img.src = src;
      el.classList.toggle('folded', p.inHand && p.folded);
      el.classList.toggle('out', !p.inHand && S.street !== '');
      el.classList.toggle('offline', !p.bot && !p.online);
      el.classList.toggle('active', S.toAct === i);
      el.classList.toggle('dealer-on', S.dealer === i);
      el.classList.toggle('winner', p.won > 0);
      el.querySelector('.stack').textContent = p.stack;
      const bet = el.querySelector('.bet'), mini = el.querySelector('.mini-cards');
      if (p.won > 0) { bet.textContent = `+${p.won}`; bet.classList.add('on', 'win'); }
      else if (p.bet > 0) { bet.textContent = p.bet; bet.classList.add('on'); bet.classList.remove('win'); }
      else bet.classList.remove('on', 'win');
      if (p.cards && i !== S.you && p.show) {
        mini.innerHTML = p.cards.map(c => `<div class="mini ${isRed(c[1]) ? 'red' : ''}">${rankCh(c[0])}${'♥♠♦♣'['hsdc'.indexOf(c[1])]}</div>`).join('');
        mini.classList.add('on');
      } else mini.classList.remove('on');
    });
  }

  const slotEls = [];
  for (let i = 0; i < 5; i++) { const s = document.createElement('div'); s.className = 'slot'; s.innerHTML = '<div class="card back"></div>'; boardEl.appendChild(s); slotEls.push(s); }
  function renderBoard() {
    if (S.community.length < boardShown) { slotEls.forEach(s => s.innerHTML = '<div class="card back"></div>'); boardShown = 0; }
    for (let i = boardShown; i < S.community.length; i++) {
      const c = S.community[i], slot = slotEls[i];
      setTimeout(() => { slot.innerHTML = cardHTML(c, 'flip'); }, (i - boardShown) * 120);
    }
    boardShown = S.community.length;
    potEl.textContent = S.pot;
    statusEl.textContent = S.status || '';
    statusEl.classList.toggle('hl', !!S.hl);
  }

  function renderHole() {
    const p = me(); const cards = (p && p.cards) || [];
    const key = cards.map(c => c.join('')).join(',');
    if (key !== holeKey) {
      holeKey = key;
      holeEls.forEach((el, i) => {
        const c = cards[i];
        el.innerHTML = c ? cardHTML(c, 'deal') : '';
        if (c) el.firstChild.style.animationDelay = (i * 120) + 'ms';
      });
    }
    handEl.classList.toggle('folded', !!(p && p.inHand && p.folded));
  }

  function renderMe() {
    const p = me(); if (!p) return;
    $('me-stack').textContent = p.stack;
    $('me-avatar').src = avatarSrc(p.avatar);
    const r = $('me-rank');
    if (p.cards && p.cards.length) r.textContent = p.folded ? 'Пас' : handName(evalBest(p.cards.concat(S.community)));
    else r.textContent = (!p.inHand && S.street) ? 'Ждём раздачу' : '';
    if (!r.textContent) r.innerHTML = '&nbsp;';
  }

  function renderActions() {
    const on = myTurn();
    actionsEl.classList.toggle('off', !on);
    if (!on) { if ($('sheet-raise').hidden === false) closeSheets(); return; }
    const tc = toCallMe();
    btnCall.textContent = tc <= 0 ? 'Чек' : (tc >= me().stack ? `Олл-ин ${tc}` : `Колл ${tc}`);
    const rt = minRaiseTo();
    const canRaise = rt > S.currentBet && me().stack > tc;
    btnRaise.style.opacity = canRaise ? '' : '.35';
    btnRaise.style.pointerEvents = canRaise ? '' : 'none';
    btnRaise.textContent = (S.currentBet === 0 ? 'Ставка ' : 'Рейз ') + rt;
  }

  // таймер хода
  let timerRaf = null, hapticDone = false;
  function renderTimer() {
    cancelAnimationFrame(timerRaf);
    const bar = $('timerbar');
    if (!myTurn()) { bar.classList.remove('on'); return; }
    bar.classList.add('on'); hapticDone = false;
    const total = Math.max(1000, S.deadline - Date.now());
    const tick = () => {
      const left = S.deadline - Date.now();
      timerBar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;
      timerBar.classList.toggle('warn', left < 8000);
      if (left < 8000 && !hapticDone) { hapticDone = true; haptic('medium'); }
      if (left > 0 && myTurn()) timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function renderAll() { renderSeats(); renderBoard(); renderHole(); renderMe(); renderActions(); renderTimer(); }

  // ---------- действия игрока ----------
  function act(d) { if (!myTurn()) return; haptic('light'); send(Object.assign({ t: 'act' }, d)); actionsEl.classList.add('off'); }
  btnCall.addEventListener('click', () => act({ type: toCallMe() <= 0 ? 'check' : 'call' }));
  btnRaise.addEventListener('click', () => act({ type: 'raise', to: minRaiseTo() }));
  btnMore.addEventListener('click', () => { if (myTurn()) openRaiseSheet(); });

  const range = $('raise-range'), raiseVal = $('raise-val'), raiseConfirm = $('btn-raise-confirm');
  function openRaiseSheet() {
    haptic('light');
    const min = minRaiseTo(), max = maxRaiseTo();
    range.min = min; range.max = max; range.step = Math.min(5, Math.max(1, max - min)); range.value = min;
    range.disabled = max <= min;
    updateRaiseLabel(); openSheet('sheet-raise');
  }
  function updateRaiseLabel() {
    const v = +range.value, max = maxRaiseTo();
    raiseVal.textContent = v;
    raiseConfirm.textContent = v >= max ? `Олл-ин ${max}` : (S.currentBet === 0 ? `Ставка ${v}` : `Рейз ${v}`);
  }
  range.addEventListener('input', () => { haptic('sel'); updateRaiseLabel(); });
  document.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    const potNow = S.pot + S.players.reduce((a, x) => a + x.bet, 0) + toCallMe();
    const min = minRaiseTo(), max = maxRaiseTo();
    let v = b.dataset.frac === 'max' ? max : Math.round((S.currentBet + potNow * +b.dataset.frac) / 5) * 5;
    range.value = Math.max(min, Math.min(max, v)); updateRaiseLabel(); haptic('sel');
  }));
  raiseConfirm.addEventListener('click', () => { closeSheets(); act({ type: 'raise', to: +range.value }); });
  $('btn-fold').addEventListener('click', () => { closeSheets(); doFold(); });
  function doFold() { if (!myTurn()) return; handEl.classList.add('folded'); act({ type: 'fold' }); }

  let drag = null;
  handEl.addEventListener('pointerdown', e => { if (!myTurn()) return; drag = { y: e.clientY, dy: 0 }; handEl.classList.add('dragging'); handEl.setPointerCapture(e.pointerId); });
  handEl.addEventListener('pointermove', e => { if (!drag) return; drag.dy = Math.max(0, e.clientY - drag.y); holeEls.forEach(el => el.style.transform = `translateY(${drag.dy}px)`); });
  const endDrag = () => { if (!drag) return; const dy = drag.dy; drag = null; handEl.classList.remove('dragging'); holeEls.forEach(el => el.style.transform = ''); if (dy > 70) doFold(); };
  handEl.addEventListener('pointerup', endDrag); handEl.addEventListener('pointercancel', endDrag);

  // ---------- шиты ----------
  function openSheet(id) {
    closeSheets();
    if (id === 'sheet-avatar') markAvatar();
    if (id === 'sheet-menu') $('menu-addbot').hidden = !isHost() || !S || S.players.length >= 5;
    $(id).hidden = false;
  }
  function closeSheets() { document.querySelectorAll('.overlay').forEach(o => o.hidden = true); }
  document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeSheets(); }));
  $('btn-menu').addEventListener('click', () => openSheet('sheet-menu'));
  $('btn-back').addEventListener('click', onBack);
  $('menu-close').addEventListener('click', closeSheets);
  $('menu-rules').addEventListener('click', () => openSheet('sheet-rules'));
  $('rules-close').addEventListener('click', closeSheets);
  $('menu-invite').addEventListener('click', () => { closeSheets(); invite(); });
  $('menu-addbot').addEventListener('click', () => { closeSheets(); send({ t: 'add_bot' }); });
  $('menu-avatar').addEventListener('click', () => openSheet('sheet-avatar'));
  $('menu-leave').addEventListener('click', () => { closeSheets(); send({ t: 'leave' }); });

  // ---------- старт ----------
  showScreen('home');
  connect();
})();
