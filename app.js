/* Poker — Telegram Mini App. Texas Hold'em vs 4 bots. */
(() => {
  'use strict';

  // ---------- Telegram ----------
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTG = !!(tg && tg.initData);
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor && tg.setHeaderColor('#000000');
      tg.setBackgroundColor && tg.setBackgroundColor('#000000');
      tg.setBottomBarColor && tg.setBottomBarColor('#000000');
      tg.disableVerticalSwipes && tg.disableVerticalSwipes();
      if (inTG) {
        tg.BackButton.show();
        tg.BackButton.onClick(() => tg.close());
        if (tg.SettingsButton) { tg.SettingsButton.show(); tg.SettingsButton.onClick(() => openSheet('sheet-menu')); }
      }
    } catch (e) { /* ignore */ }
  }
  const haptic = (t) => { try { t === 'sel' ? tg.HapticFeedback.selectionChanged() : tg.HapticFeedback.impactOccurred(t || 'light'); } catch (e) {} };

  // ---------- constants ----------
  const SB = 5, BB = 10, START = 250;
  const SUITS = ['h', 's', 'd', 'c'];
  const RANK_CH = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const HAND_NAMES = ['Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];
  const SUIT_SVG = {
    h: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    d: '<svg viewBox="0 0 24 24"><path d="M12 2.8 20.6 12 12 21.2 3.4 12z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>',
    s: '<svg viewBox="0 0 24 24"><path d="M12 2C12 2 4 8.6 4 13.4a4.1 4.1 0 0 0 6.9 3c-.3 1.8-1.3 3.4-2.9 4.6h8c-1.6-1.2-2.6-2.8-2.9-4.6a4.1 4.1 0 0 0 6.9-3C20 8.6 12 2 12 2z"/></svg>',
    c: '<svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="4.2"/><circle cx="6.6" cy="13.6" r="4.2"/><circle cx="17.4" cy="13.6" r="4.2"/><path d="M10.4 12h3.2c0 3.4 1 6.3 2.6 9H7.8c1.6-2.7 2.6-5.6 2.6-9z"/></svg>'
  };

  const tgName = (() => {
    try { const u = tg.initDataUnsafe.user; return (u && (u.first_name || u.username)) || null; } catch (e) { return null; }
  })();

  // ---------- players ----------
  const P = [
    { name: 'Эли', avatar: 'assets/eli.png', aggr: 0.45, loose: 0.5 },
    { name: tgName || 'Джейн', avatar: 'assets/jane.png', human: true },
    { name: 'Джина', avatar: 'assets/gina.png', aggr: 0.7, loose: 0.65 },
    { name: 'Стив', avatar: 'assets/steve.png', aggr: 0.35, loose: 0.35 },
    { name: 'Роуз', avatar: 'assets/rose.png', aggr: 0.6, loose: 0.55 }
  ];
  P.forEach((p, i) => { p.id = i; p.stack = START; p.out = false; });
  const ME = P[1];

  const S = { dealer: -1, community: [], pot: 0, currentBet: 0, minRaise: BB, street: '', deck: [], busy: false, handNo: 0 };

  // ---------- persistence ----------
  const KEY = 'poker.stacks.v1';
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ stacks: P.map(p => p.stack), dealer: S.dealer })); } catch (e) {} }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.stacks && d.stacks.length === 5 && d.stacks[1] > 0 && d.stacks.filter(s => s > 0).length > 1) {
        d.stacks.forEach((s, i) => { P[i].stack = s; P[i].out = s <= 0; });
        S.dealer = d.dealer;
      }
    } catch (e) {}
  }

  // ---------- cards ----------
  const newDeck = () => { const d = []; for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ r, s }); return d; };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const rankCh = (r) => RANK_CH[r] || String(r);
  const isRed = (s) => s === 'h' || s === 'd';

  function groups(cards) {
    const cnt = {};
    cards.forEach(c => cnt[c.r] = (cnt[c.r] || 0) + 1);
    return Object.keys(cnt).map(r => [cnt[r], +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  }
  function eval5(c) {
    const rs = c.map(x => x.r).sort((a, b) => b - a);
    const flush = c.every(x => x.s === c[0].s);
    let straight = 0;
    if (new Set(rs).size === 5) {
      if (rs[0] - rs[4] === 4) straight = rs[0];
      else if (rs[0] === 14 && rs[1] === 5 && rs[4] === 2) straight = 5;
    }
    if (straight && flush) return [8, straight];
    const g = groups(c);
    const flat = g.map(x => x[1]);
    if (g[0][0] === 4) return [7, ...flat];
    if (g[0][0] === 3 && g[1][0] === 2) return [6, ...flat];
    if (flush) return [5, ...rs];
    if (straight) return [4, straight];
    if (g[0][0] === 3) return [3, ...flat];
    if (g[0][0] === 2 && g[1][0] === 2) return [2, ...flat];
    if (g[0][0] === 2) return [1, ...flat];
    return [0, ...rs];
  }
  function combos(arr, k) {
    const out = [];
    (function rec(start, cur) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
    })(0, []);
    return out;
  }
  const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
  function evalBest(cards) {
    if (cards.length < 5) {
      const g = groups(cards); const flat = g.map(x => x[1]);
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
  const handName = (score) => (score[0] === 8 && score[1] === 14) ? 'Флеш-рояль' : HAND_NAMES[score[0]];

  // ---------- helpers ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const alive = () => P.filter(p => !p.out);
  const inHand = () => P.filter(p => !p.folded);
  const canAct = (p) => !p.folded && !p.allIn && !p.out;
  function nextIdx(i, pred) { for (let k = 1; k <= 5; k++) { const j = (i + k) % 5; if (pred(P[j])) return j; } return -1; }
  const nextAlive = (i) => nextIdx(i, p => !p.out);
  const nextActor = (i) => nextIdx(i, canAct);

  function commit(p, amt) {
    amt = Math.min(amt, p.stack);
    p.stack -= amt; p.bet += amt; p.total += amt;
    if (p.stack === 0) p.allIn = true;
    return amt;
  }

  // ---------- bot AI ----------
  function preflopStrength(cards) {
    const [a, b] = cards.map(c => c.r).sort((x, y) => y - x);
    const suited = cards[0].s === cards[1].s;
    if (a === b) return 0.55 + (a - 2) / 12 * 0.45;
    let s = ((a + b) / 28) * 0.62;
    const gap = a - b;
    if (suited) s += 0.07;
    if (gap === 1) s += 0.07; else if (gap === 2) s += 0.04; else if (gap > 4) s -= 0.06;
    if (a === 14) s += 0.06;
    return Math.max(0.05, Math.min(0.85, s));
  }
  function postflopStrength(p) {
    const all = p.cards.concat(S.community);
    const score = evalBest(all);
    const boardTop = Math.max(...S.community.map(c => c.r));
    const boardScore = evalBest(S.community);
    let s;
    switch (score[0]) {
      case 0: s = 0.12 + (score[1] === 14 ? 0.08 : 0); break;
      case 1: s = boardScore[0] >= 1 ? 0.28 : (score[1] >= boardTop ? 0.55 : 0.4); break;
      case 2: s = boardScore[0] >= 2 ? 0.45 : 0.7; break;
      case 3: s = 0.8; break;
      case 4: s = 0.87; break;
      case 5: s = 0.9; break;
      default: s = 0.97;
    }
    if (S.community.length < 5) {
      const suits = {}; all.forEach(c => suits[c.s] = (suits[c.s] || 0) + 1);
      if (Object.values(suits).some(n => n === 4)) s += 0.18;
      const rs = [...new Set(all.map(c => c.r))].sort((a, b) => a - b);
      let run = 1, maxRun = 1;
      for (let i = 1; i < rs.length; i++) { run = rs[i] - rs[i - 1] === 1 ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
      if (maxRun === 4) s += 0.15;
    }
    return Math.min(1, s);
  }
  function botDecide(p) {
    const toCall = S.currentBet - p.bet;
    const potNow = S.pot + P.reduce((a, x) => a + x.bet, 0);
    let s = S.street === 'preflop' ? preflopStrength(p.cards) : postflopStrength(p);
    s += (Math.random() - 0.5) * 0.16 + (p.loose - 0.5) * 0.15;
    const aggr = p.aggr;
    const minTo = S.currentBet + S.minRaise;
    const raiseTo = (mult) => {
      let to = Math.max(minTo, Math.round((potNow * mult) / 5) * 5);
      return Math.min(to, p.stack + p.bet);
    };
    if (toCall <= 0) {
      if (s > 0.62 && Math.random() < aggr + 0.2) return { type: 'raise', to: raiseTo(0.5 + Math.random() * 0.5) };
      if (s < 0.3 && Math.random() < aggr * 0.25) return { type: 'raise', to: raiseTo(0.5) }; // bluff
      return { type: 'check' };
    }
    const potOdds = toCall / (potNow + toCall);
    if (toCall >= p.stack) { // facing all-in decision
      return s > 0.72 || (s > 0.5 && potOdds < 0.3) ? { type: 'call' } : { type: 'fold' };
    }
    if (s > 0.78 && Math.random() < aggr + 0.15) return { type: 'raise', to: raiseTo(0.7 + Math.random() * 0.6) };
    if (s > potOdds + 0.12) return { type: 'call' };
    if (toCall <= BB && s > 0.22 && Math.random() < p.loose) return { type: 'call' };
    if (Math.random() < aggr * 0.12 && S.street !== 'preflop') return { type: 'raise', to: raiseTo(0.8) };
    return { type: 'fold' };
  }

  // ---------- game flow ----------
  let humanResolve = null;
  let handToken = 0;

  async function newGame() {
    P.forEach(p => { p.stack = START; p.out = false; });
    S.dealer = -1; save();
    startHand();
  }

  function startHand() {
    const token = ++handToken;
    playHand(token).catch(e => console.error(e));
  }

  async function playHand(token) {
    const live = () => token === handToken;
    if (alive().length < 2 || ME.out) return gameOver();
    S.handNo++;
    P.forEach(p => { p.cards = []; p.bet = 0; p.total = 0; p.folded = p.out; p.allIn = false; p.acted = false; p.show = false; p.won = 0; });
    S.community = []; S.pot = 0; S.deck = shuffle(newDeck()); S.street = 'preflop'; S.msg = ''; S.toAct = -1;
    S.dealer = nextAlive(S.dealer < 0 ? Math.floor(Math.random() * 5) : S.dealer);
    const n = alive().length;
    const sbIdx = n === 2 ? S.dealer : nextAlive(S.dealer);
    const bbIdx = nextAlive(sbIdx);
    commit(P[sbIdx], SB); commit(P[bbIdx], BB);
    S.currentBet = BB; S.minRaise = BB;
    handEl.classList.remove('folded');
    renderAll();
    // deal
    let i = sbIdx;
    for (let r = 0; r < 2; r++) for (let k = 0; k < n; k++) { P[i].cards.push(S.deck.pop()); i = nextAlive(i); }
    renderHole(true);
    await sleep(500); if (!live()) return;

    let done = await bettingRound(nextActor(bbIdx), token);
    if (!live()) return;
    const streets = [['flop', 3], ['turn', 1], ['river', 1]];
    for (const [name, cnt] of streets) {
      if (done) break;
      S.street = name; S.currentBet = 0; S.minRaise = BB;
      for (let k = 0; k < cnt; k++) S.community.push(S.deck.pop());
      S.toAct = -1; renderAll();
      await sleep(700); if (!live()) return;
      done = await bettingRound(nextActor(S.dealer), token);
      if (!live()) return;
    }
    await showdown(token);
  }

  async function bettingRound(startIdx, token) {
    P.forEach(p => p.acted = false);
    let idx = startIdx;
    while (true) {
      if (inHand().length === 1) break;
      const actors = P.filter(canAct);
      const pending = actors.filter(p => !p.acted || p.bet < S.currentBet);
      if (!pending.length) break;
      if (actors.length === 1 && actors[0].bet >= S.currentBet) break;
      if (idx < 0) break;
      const p = P[idx];
      if (canAct(p) && (!p.acted || p.bet < S.currentBet)) {
        await act(p, token);
        if (token !== handToken) return true;
      }
      idx = nextActor(idx);
    }
    // sweep bets into pot
    await sleep(350);
    S.pot += P.reduce((a, p) => a + p.bet, 0);
    P.forEach(p => p.bet = 0);
    S.toAct = -1; renderAll();
    if (inHand().length === 1) return true;
    // all-in run-out: nobody left to act
    const actors = P.filter(canAct);
    if (actors.length <= 1) {
      if (S.community.length < 5) {
        inHand().forEach(p => p.show = true);
        renderAll();
        while (S.community.length < 5) { await sleep(900); S.community.push(S.deck.pop()); renderAll(); }
        await sleep(600);
      }
      return true;
    }
    return false;
  }

  async function act(p, token) {
    S.toAct = p.id;
    let d;
    if (p.human) {
      const pr = new Promise(res => { humanResolve = res; });
      renderAll();
      d = await pr;
      humanResolve = null;
    } else {
      renderAll();
      await sleep(650 + Math.random() * 700);
      if (token !== handToken) return;
      d = botDecide(p);
    }
    applyAction(p, d);
    renderAll();
    await sleep(p.human ? 250 : 200);
  }

  function applyAction(p, d) {
    const toCall = S.currentBet - p.bet;
    if (d.type === 'fold') { p.folded = true; setStatus(`${p.name} пасует`); return; }
    if (d.type === 'check' || (d.type === 'call' && toCall <= 0)) { p.acted = true; setStatus(`${p.name} чекает`); return; }
    if (d.type === 'call') {
      const amt = commit(p, toCall); p.acted = true;
      setStatus(p.allIn && amt < toCall ? `${p.name} идёт олл-ин ${amt}` : (p.allIn ? `${p.name} уравнивает олл-ин` : `${p.name} уравнивает ${amt}`));
      return;
    }
    if (d.type === 'raise') {
      let to = Math.min(d.to, p.stack + p.bet);
      const minTo = S.currentBet + S.minRaise;
      if (to < minTo && to < p.stack + p.bet) to = Math.min(minTo, p.stack + p.bet);
      if (to <= S.currentBet) { // can't raise: treat as call
        commit(p, toCall); p.acted = true; setStatus(`${p.name} уравнивает олл-ин`); return;
      }
      commit(p, to - p.bet);
      const size = to - S.currentBet;
      const wasBet = S.currentBet === 0;
      if (size >= S.minRaise) { S.minRaise = size; P.forEach(x => { if (x !== p) x.acted = false; }); }
      S.currentBet = to; p.acted = true;
      setStatus(p.allIn ? `${p.name} идёт олл-ин ${to}` : (wasBet ? `${p.name} ставит ${to}` : `${p.name} повышает до ${to}`));
    }
  }

  async function showdown(token) {
    S.street = 'showdown'; S.toAct = -1;
    const contenders = inHand();
    const results = [];
    if (contenders.length === 1) {
      const w = contenders[0]; w.won = S.pot; w.stack += S.pot;
      results.push(`${w.name} забирает ${S.pot}`);
    } else {
      contenders.forEach(p => { p.show = true; p.score = evalBest(p.cards.concat(S.community)); });
      const levels = [...new Set(contenders.map(p => p.total))].sort((a, b) => a - b);
      let prev = 0;
      const totalIn = P.reduce((a, p) => a + p.total, 0);
      let distributed = 0;
      levels.forEach((L, li) => {
        let portion = P.reduce((a, p) => a + Math.min(p.total, L), 0) - P.reduce((a, p) => a + Math.min(p.total, prev), 0);
        if (li === levels.length - 1) portion = totalIn - distributed; // leftovers (folded overbets)
        distributed += portion; prev = L;
        if (portion <= 0) return;
        const elig = contenders.filter(p => p.total >= L);
        let best = null; elig.forEach(p => { if (!best || cmp(p.score, best) > 0) best = p.score; });
        const winners = elig.filter(p => cmp(p.score, best) === 0);
        const share = Math.floor(portion / winners.length);
        winners.forEach((w, i) => { const amt = share + (i === 0 ? portion - share * winners.length : 0); w.won += amt; w.stack += amt; });
      });
      const ws = contenders.filter(p => p.won > 0);
      results.push(ws.map(w => `${w.name} выигрывает ${w.won} · ${handName(w.score)}`).join(', '));
    }
    S.pot = 0;
    setStatus(results.join(' '), true);
    renderAll();
    P.forEach(p => { if (p.stack <= 0) p.out = true; });
    save();
    haptic(ME.won > 0 ? 'medium' : 'light');
    await sleep(contenders.length === 1 ? 1800 : 3600);
    if (token !== handToken) return;
    if (ME.out || alive().length < 2) return gameOver();
    startHand();
  }

  function gameOver() {
    const win = !ME.out && alive().length < 2;
    document.getElementById('over-title').textContent = win ? 'Вы выиграли!' : 'Вы вылетели';
    document.getElementById('over-sub').textContent = win ? `Вы забрали все ${P.reduce((a, p) => a + p.stack, 0)} фишек.` : 'Повезёт в следующий раз.';
    openSheet('sheet-over');
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  // ---------- human input ----------
  function humanAct(d) { if (!humanResolve) return; haptic('light'); const r = humanResolve; humanResolve = null; r(d); }
  const myTurn = () => S.toAct === ME.id && humanResolve;
  const toCallMe = () => Math.min(S.currentBet - ME.bet, ME.stack);
  const minRaiseTo = () => Math.min(S.currentBet + S.minRaise, ME.stack + ME.bet);
  const maxRaiseTo = () => ME.stack + ME.bet;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const seatsEl = $('seats'), boardEl = $('board'), potEl = $('pot'), statusEl = $('status'), actionsEl = $('actions');
  const handEl = $('hand'), holeEls = [$('hole0'), $('hole1')];
  const btnCall = $('btn-call'), btnRaise = $('btn-raise'), btnMore = $('btn-more');

  if (inTG) $('topbar').hidden = true;

  function cardHTML(c, extra) {
    const wide = c.r === 10;
    return `<div class="card ${isRed(c.s) ? 'red' : ''} ${extra || ''}"><div class="rank ${wide ? 'wide' : ''}">${rankCh(c.r)}</div><div class="suit">${SUIT_SVG[c.s]}</div></div>`;
  }

  // seats
  const seatEls = P.map(p => {
    const el = document.createElement('div');
    el.className = 'seat';
    el.innerHTML = `<div class="avatar-wrap"><img class="avatar" src="${p.avatar}" alt=""><div class="dealer">D</div></div>
      <div class="name">${p.name}</div><div class="stack">${p.stack}</div>
      <div class="bet-wrap"><div class="bet"></div><div class="mini-cards"></div></div>`;
    seatsEl.appendChild(el);
    return el;
  });
  $('me-avatar').src = ME.avatar;

  // board slots
  const slotEls = [];
  for (let i = 0; i < 5; i++) { const s = document.createElement('div'); s.className = 'slot'; s.innerHTML = '<div class="card back"></div>'; boardEl.appendChild(s); slotEls.push(s); }
  let boardShown = 0;

  function setStatus(t, hl) { S.msg = t; statusEl.textContent = t; statusEl.classList.toggle('hl', !!hl); }

  function renderSeats() {
    P.forEach((p, i) => {
      const el = seatEls[i];
      el.classList.toggle('folded', p.folded && !p.out);
      el.classList.toggle('out', p.out);
      el.classList.toggle('active', S.toAct === i);
      el.classList.toggle('dealer-on', S.dealer === i && !p.out);
      el.classList.toggle('winner', p.won > 0);
      el.querySelector('.stack').textContent = p.stack;
      const bet = el.querySelector('.bet'), mini = el.querySelector('.mini-cards');
      if (p.won > 0) { bet.textContent = `+${p.won}`; bet.classList.add('on', 'win'); mini.classList.remove('on'); }
      else if (p.bet > 0) { bet.textContent = p.bet; bet.classList.add('on'); bet.classList.remove('win'); mini.classList.remove('on'); }
      else { bet.classList.remove('on', 'win'); }
      if (p.show && !p.human && p.won <= 0) {
        mini.innerHTML = p.cards.map(c => `<div class="mini ${isRed(c.s) ? 'red' : ''}">${rankCh(c.r)}${'♥♠♦♣'['hsdc'.indexOf(c.s)]}</div>`).join('');
        mini.classList.add('on');
      } else if (p.show && !p.human && p.won > 0) {
        // show cards next to win amount: put cards in mini, amount in bet
        mini.innerHTML = p.cards.map(c => `<div class="mini ${isRed(c.s) ? 'red' : ''}">${rankCh(c.r)}${'♥♠♦♣'['hsdc'.indexOf(c.s)]}</div>`).join('');
        mini.classList.add('on');
      } else mini.classList.remove('on');
    });
  }

  function renderBoard() {
    if (S.community.length < boardShown) { // new hand
      slotEls.forEach(s => s.innerHTML = '<div class="card back"></div>');
      boardShown = 0;
    }
    for (let i = boardShown; i < S.community.length; i++) {
      const c = S.community[i];
      const slot = slotEls[i];
      setTimeout(() => { slot.innerHTML = cardHTML(c, 'flip'); }, (i - boardShown) * 120);
    }
    boardShown = S.community.length;
    potEl.textContent = S.pot;
  }

  function renderHole(deal) {
    holeEls.forEach((el, i) => {
      const c = ME.cards[i];
      el.innerHTML = c ? cardHTML(c, deal ? 'deal' : '') : '';
      if (deal && c) el.firstChild.style.animationDelay = (i * 120) + 'ms';
    });
  }

  function renderMe() {
    $('me-stack').textContent = ME.stack;
    const r = $('me-rank');
    if (ME.cards && ME.cards.length) r.textContent = ME.folded ? 'Пас' : handName(evalBest(ME.cards.concat(S.community)));
    else r.innerHTML = '&nbsp;';
  }

  function renderActions() {
    const on = !!myTurn();
    actionsEl.classList.toggle('off', !on);
    if (!on) return;
    const tc = toCallMe();
    btnCall.textContent = tc <= 0 ? 'Чек' : (tc >= ME.stack ? `Олл-ин ${tc}` : `Колл ${tc}`);
    const rt = minRaiseTo();
    const canRaise = rt > S.currentBet && ME.stack > tc;
    btnRaise.style.opacity = canRaise ? '' : '.35';
    btnRaise.style.pointerEvents = canRaise ? '' : 'none';
    btnRaise.textContent = (S.currentBet === 0 ? 'Ставка ' : 'Рейз ') + rt;
  }

  function renderAll() { renderSeats(); renderBoard(); renderMe(); renderActions(); }

  // ---------- buttons ----------
  btnCall.addEventListener('click', () => { if (!myTurn()) return; humanAct({ type: toCallMe() <= 0 ? 'check' : 'call' }); });
  btnRaise.addEventListener('click', () => { if (!myTurn()) return; humanAct({ type: 'raise', to: minRaiseTo() }); });
  btnMore.addEventListener('click', () => { if (!myTurn()) return; openRaiseSheet(); });

  const range = $('raise-range'), raiseVal = $('raise-val'), raiseConfirm = $('btn-raise-confirm');
  function openRaiseSheet() {
    haptic('light');
    const min = minRaiseTo(), max = maxRaiseTo();
    range.min = min; range.max = max; range.step = Math.min(5, Math.max(1, max - min)); range.value = min;
    range.disabled = max <= min;
    updateRaiseLabel();
    openSheet('sheet-raise');
  }
  function updateRaiseLabel() {
    const v = +range.value, max = maxRaiseTo();
    raiseVal.textContent = v;
    raiseConfirm.textContent = v >= max ? `Олл-ин ${max}` : (S.currentBet === 0 ? `Ставка ${v}` : `Рейз ${v}`);
  }
  range.addEventListener('input', () => { haptic('sel'); updateRaiseLabel(); });
  document.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    const potNow = S.pot + P.reduce((a, x) => a + x.bet, 0) + toCallMe();
    const min = minRaiseTo(), max = maxRaiseTo();
    let v = b.dataset.frac === 'max' ? max : Math.round((S.currentBet + potNow * +b.dataset.frac) / 5) * 5;
    v = Math.max(min, Math.min(max, v));
    range.value = v; updateRaiseLabel(); haptic('sel');
  }));
  raiseConfirm.addEventListener('click', () => { closeSheets(); humanAct({ type: 'raise', to: +range.value }); });
  $('btn-fold').addEventListener('click', () => { closeSheets(); doFold(); });
  function doFold() { if (!myTurn()) return; handEl.classList.add('folded'); humanAct({ type: 'fold' }); }

  // swipe cards down to fold
  let drag = null;
  handEl.addEventListener('pointerdown', e => { if (!myTurn()) return; drag = { y: e.clientY, dy: 0 }; handEl.classList.add('dragging'); handEl.setPointerCapture(e.pointerId); });
  handEl.addEventListener('pointermove', e => {
    if (!drag) return; drag.dy = Math.max(0, e.clientY - drag.y);
    holeEls.forEach(el => el.style.transform = `translateY(${drag.dy}px)`);
  });
  const endDrag = () => {
    if (!drag) return; const dy = drag.dy; drag = null; handEl.classList.remove('dragging');
    holeEls.forEach(el => el.style.transform = '');
    if (dy > 70) doFold();
  };
  handEl.addEventListener('pointerup', endDrag); handEl.addEventListener('pointercancel', endDrag);

  // sheets
  function openSheet(id) { closeSheets(); $(id).hidden = false; }
  function closeSheets() { document.querySelectorAll('.overlay').forEach(o => o.hidden = true); }
  document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o && o.id !== 'sheet-over') closeSheets(); }));
  $('btn-menu').addEventListener('click', () => openSheet('sheet-menu'));
  $('btn-back').addEventListener('click', () => { if (tg && inTG) tg.close(); else history.back(); });
  $('menu-close').addEventListener('click', closeSheets);
  $('menu-rules').addEventListener('click', () => openSheet('sheet-rules'));
  $('rules-close').addEventListener('click', closeSheets);
  $('menu-new').addEventListener('click', () => { closeSheets(); humanResolve = null; newGame(); });
  $('over-new').addEventListener('click', () => { closeSheets(); newGame(); });

  // ---------- start ----------
  load();
  renderAll();
  startHand();
})();
