const API_BASE = '/.netlify/functions';

const WALLET_ENDPOINTS = {
  ethereum: 'wallets-eth',
  robinhood: 'wallets-robinhood',
  solana: 'wallets-solana'
};

const SECTION_ORDER = ['wallets', 'updates', 'watchlist', 'charts', 'chat'];

const app = {
  wallets: [],
  watchlist: [],
  chatHistory: [],
  walletSignals: [],
  newsItems: [],
  trends: [],
  trendHistory: [],
  livePrice: null,
  trendingTokens: [],
  walletPortfolios: {},
  activeWalletFilter: null,
  syncCode: null,
  lastModified: 0,
  syncPushTimer: null,
  syncInProgress: false,
  expandedWallet: null,
  alerts: [],
  recognition: null,
  isListening: false, // deprecated, kept only to avoid breaking any stray references
  synth: window.speechSynthesis,
  sectionsOpen: { wallets: false, updates: false, watchlist: false, charts: false, chat: false },
  lastScannedMint: null,
  lastScannedPair: null,

  speakGreeting() {
    const hour = new Date().getHours();
    let timeGreeting = 'Good evening';
    if (hour < 12) timeGreeting = 'Good morning';
    else if (hour < 18) timeGreeting = 'Good afternoon';
    // Browsers often block speech synthesis that isn't tied to a user
    // gesture, so this may not always play automatically - that's an
    // inherent browser restriction, not a bug. It'll still work fine the
    // moment the user taps anything on the page.
    this.speak(`${timeGreeting}, Edwin. What do you want us to do?`);
  },

  async init() {
    this.speakGreeting();
    this.loadWallets();
    this.renderWallets();
    this.renderWalletFilters();
    this.loadWatchlist();
    this.renderWatchlist();
    this.loadChatHistory();
    this.renderChatHistory();
    this.loadTrendHistory();
    this.loadAlerts();
    this.renderAlerts();
    this.initSync();
    this.registerServiceWorker().then(() => this.checkPushStatus());

    document.getElementById('chatInput').addEventListener('keypress', e => {
      if (e.key === 'Enter') this.sendChat();
    });
    document.getElementById('walletInput')?.addEventListener('keypress', e => {
      if (e.key === 'Enter') this.addWallet();
    });
    document.getElementById('tokenInput')?.addEventListener('keypress', e => {
      if (e.key === 'Enter') this.checkToken();
    });

    this.setupSpeechRecognition();

    // Desktop shows the sidebar dashboard, starting on the Home page.
    // Mobile always shows the normal stacked card list directly.
    this.isDesktop = window.innerWidth >= 900;
    if (this.isDesktop) {
      document.getElementById('sidebarNav').style.display = 'flex';
      document.getElementById('topBadge').style.display = 'inline-flex';
      this.showPage('home');
    }

    await this.refresh();
    setInterval(() => this.refresh(), 5 * 60 * 1000);

    // Keep displayed "time ago" labels accurate without needing a full
    // refetch - re-render from cached data every 30s.
    setInterval(() => {
      this.renderWalletSignals();
      this.renderNews();
      this.renderWatchlist();
    }, 30 * 1000);
  },

  // ---------- Sidebar dashboard page switching (desktop only) ----------
  ALL_PAGE_IDS: ['page-home', 'page-tradebot'],
  ALL_GROUP_IDS: { wallets: 'walletsGroup', updates: 'updatesGroup', watchlist: 'watchlistGroup', charts: 'chartsGroup', chat: 'chatGroup', settings: 'settingsGroup', stage3: 'stage3Group' },

  showPage(name) {
if (!this.isDesktop && name !== 'tradebot' && name !== 'home') {
this.openSection(name);
return;
}

    // Hide every standalone page and every card-group first.
    this.ALL_PAGE_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    Object.values(this.ALL_GROUP_IDS).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    // Update nav active state
    document.querySelectorAll('.sidebar-nav-desktop .nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === name);
    });

    document.getElementById('hubBackBar').style.display = name === 'home' ? 'none' : 'flex';

    if (name === 'home' || name === 'tradebot') {
      document.getElementById(`page-${name}`).style.display = 'block';
      if (name === 'home') this.renderHomeDashboard();
    } else if (this.ALL_GROUP_IDS[name]) {
      document.getElementById(this.ALL_GROUP_IDS[name]).style.display = 'block';
      this.openSection(name);
      document.getElementById(`${name}CardHeader`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  },

  closeHubDetail() {
    if (!this.isDesktop) return;
    this.showPage('home');
  },

  // Unified entry point other code should use instead of calling
  // openSection/showPage directly, so behavior stays consistent whether
  // the sidebar dashboard is active or not.
  goToSection(name) {
    if (this.isDesktop) this.showPage(name);
    else this.openSection(name);
  },

  renderHomeDashboard() {
    const walletsCount = this.wallets.length;
    const scannedCount = this.watchlist.length;
    const alertsCount = this.alerts.length;

    document.getElementById('homeWalletsCount').textContent = walletsCount;
    document.getElementById('homeScannedCount').textContent = scannedCount;
    document.getElementById('homeAlertsCount').textContent = alertsCount;
    document.getElementById('homeUsageWallets').textContent = walletsCount;
    document.getElementById('homeUsageScans').textContent = scannedCount;

    if (scannedCount > 0) {
      const levelScore = { low: 1, medium: 2, high: 3 };
      const avg = this.watchlist.reduce((sum, w) => sum + (levelScore[w.level] || 1), 0) / scannedCount;
      const avgLabel = avg >= 2.5 ? 'High' : avg >= 1.5 ? 'Medium' : 'Low';
      document.getElementById('homeAvgRisk').textContent = avgLabel;
    } else {
      document.getElementById('homeAvgRisk').textContent = '\u2014';
    }

    const recentEl = document.getElementById('homeRecentScans');
    if (this.watchlist.length === 0) {
      recentEl.innerHTML = '<div class="empty-note">No tokens scanned yet.</div>';
    } else {
      recentEl.innerHTML = this.watchlist.slice(0, 4).map(w => {
        const short = w.mint.slice(0, 6) + '...' + w.mint.slice(-4);
        return `<div class="watchlist-card" onclick="app.openWatchlistChart('${w.pairAddress || ''}')" style="cursor:pointer;">
          <div class="wl-top"><span class="wl-mint">${short}</span><span class="risk-badge ${w.level}">${w.level}</span></div>
          <div class="wl-time">${this.timeAgo(w.checkedAt)}</div>
        </div>`;
      }).join('');
    }

    const homeAlertsEl = document.getElementById('homeAlertsList');
    if (homeAlertsEl) {
      homeAlertsEl.innerHTML = this.alerts.length === 0
        ? '<div class="empty-note">No active alerts.</div>'
        : this.alerts.slice(0, 5).map(a => `<div class="alert-item"><span>${a.text}</span></div>`).join('');
    }

    const homeTrendingEl = document.getElementById('homeTrendingList');
    if (homeTrendingEl) {
      homeTrendingEl.innerHTML = this.trendingTokens.length === 0
        ? '<div class="empty-note">No trending data yet.</div>'
        : this.trendingTokens.slice(0, 5).map(t => {
            const changeClass = (t.priceChange24h || 0) >= 0 ? 'ok' : 'high';
            const changeSign = (t.priceChange24h || 0) >= 0 ? '+' : '';
            return `<div class="trending-token-item" onclick="app.checkToken('${t.address}', 'solana'); app.goToSection('watchlist');">
              <div class="tt-left"><div class="tt-symbol">${t.symbol || '?'}</div><div class="tt-name">${t.name || ''}</div></div>
              <div class="tt-right"><div class="tt-change ${changeClass}">${changeSign}${(t.priceChange24h || 0).toFixed(1)}%</div></div>
            </div>`;
          }).join('');
    }
  },

  toggleSection(name) {
    const isOpen = this.sectionsOpen[name];
    this.sectionsOpen[name] = !isOpen;
    document.getElementById(`${name}Body`).style.display = isOpen ? 'none' : 'block';
    document.getElementById(`${name}Chevron`).classList.toggle('open', !isOpen);
  },

  openSection(name) {
    if (!this.sectionsOpen[name]) this.toggleSection(name);
  },

  cycleNextSection() {
    const currentlyOpen = SECTION_ORDER.find(s => this.sectionsOpen[s]);
    const currentIdx = currentlyOpen ? SECTION_ORDER.indexOf(currentlyOpen) : -1;
    const nextIdx = (currentIdx + 1) % SECTION_ORDER.length;
    if (currentlyOpen) this.toggleSection(currentlyOpen);
    if (this.isDesktop) {
      this.showPage(SECTION_ORDER[nextIdx]);
    } else {
      this.toggleSection(SECTION_ORDER[nextIdx]);
      document.getElementById(`${SECTION_ORDER[nextIdx]}CardHeader`).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },

  clearChatOnly() {
    this.chatHistory = [];
    localStorage.removeItem('j7t_chat_history');
    document.getElementById('chatLog').innerHTML = '';
    this.updateChatControlsVisibility();
  },

  clearLogs() {
    this.clearChatOnly();
    this.walletSignals = [];
    this.renderWalletSignals();
    this.alerts = [];
    this.saveAlerts();
    this.renderAlerts();
  },

  updateChatControlsVisibility() {
    const controls = document.getElementById('chatLogControls');
    if (controls) controls.style.display = this.chatHistory.length > 0 ? 'flex' : 'none';
  },

  // ---------- Wallets ----------
  loadWallets() {
    try {
      const stored = localStorage.getItem('j7t_wallets');
      this.wallets = stored ? JSON.parse(stored) : [];
    } catch { this.wallets = []; }
  },
  saveWallets() { localStorage.setItem('j7t_wallets', JSON.stringify(this.wallets)); this.markModified(); },

  addWallet() {
    const input = document.getElementById('walletInput');
    const nicknameInput = document.getElementById('walletNicknameInput');
    const chain = document.getElementById('chainSelect').value;
    const address = input.value.trim();
    const nickname = nicknameInput.value.trim();
    if (!address) return;
    if (this.wallets.some(w => w.address === address && w.chain === chain)) { input.value = ''; nicknameInput.value = ''; return; }
    this.wallets.push({ address, chain, nickname: nickname || null });
    this.saveWallets();
    input.value = '';
    nicknameInput.value = '';
    this.renderWallets();
    this.renderWalletFilters();
    this.refresh();
  },

  removeWallet(address, chain) {
    this.wallets = this.wallets.filter(w => !(w.address === address && w.chain === chain));
    this.saveWallets();
    if (this.activeWalletFilter === address) this.activeWalletFilter = null;
    this.renderWallets();
    this.renderWalletFilters();
    this.renderWalletSignals();
    if (this.isDesktop) this.renderHomeDashboard();
  },

  renameWallet(address, chain) {
    const wallet = this.wallets.find(w => w.address === address && w.chain === chain);
    if (!wallet) return;
    const newName = prompt('Nickname for this wallet:', wallet.nickname || '');
    if (newName === null) return;
    wallet.nickname = newName.trim() || null;
    this.saveWallets();
    this.renderWallets();
    this.renderWalletFilters();
  },

  walletLabel(w) {
    if (w.nickname) return w.nickname;
    return w.address.length > 10 ? w.address.slice(0, 6) + '...' + w.address.slice(-4) : w.address;
  },

  toggleWalletExpand(address) {
    this.expandedWallet = this.expandedWallet === address ? null : address;
    this.renderWallets();
  },

  renderWallets() {
    const list = document.getElementById('walletList');
    document.getElementById('walletsSummary').textContent = `${this.wallets.length} watched`;
    if (this.wallets.length === 0) {
      list.innerHTML = '<div class="empty-note">No wallets added yet.</div>';
      return;
    }
    list.innerHTML = this.wallets.map(w => {
      const short = w.address.length > 10 ? w.address.slice(0, 6) + '...' + w.address.slice(-4) : w.address;
      const label = this.walletLabel(w);
      const portfolio = this.walletPortfolios[w.address];
      const isExpanded = this.expandedWallet === w.address;
      const nativeSymbol = w.chain === 'solana' ? 'SOL' : 'ETH';

      let portfolioLine = '<div class="wallet-portfolio-value muted">Loading value...</div>';
      if (portfolio) {
        if (w.chain === 'solana') {
          portfolioLine = `<div class="wallet-portfolio-value">$${portfolio.totalValueUsd.toLocaleString(undefined, {maximumFractionDigits: 2})} &middot; ${portfolio.solBalance.toFixed(3)} SOL</div>`;
        } else {
          const approxTag = portfolio.approximate ? ' (approx.)' : '';
          portfolioLine = `<div class="wallet-portfolio-value">$${(portfolio.tokensValueUsd || 0).toLocaleString(undefined, {maximumFractionDigits: 2})} in tokens${approxTag} &middot; ${portfolio.nativeBalance.toFixed(4)} ${nativeSymbol}</div>`;
        }
      }

      let breakdownHtml = '';
      if (isExpanded) {
        if (!portfolio) {
          breakdownHtml = `<div class="wallet-breakdown"><div class="empty-note">Still loading holdings...</div></div>`;
        } else if (!portfolio.topHoldings || portfolio.topHoldings.length === 0) {
          breakdownHtml = `<div class="wallet-breakdown"><div class="empty-note">No priced token holdings found.</div></div>`;
        } else {
          const approxNote = (w.chain !== 'solana' && portfolio.approximate)
            ? `<div class="empty-note" style="margin-bottom:6px;">Approximate - derived from transfer history, not a direct balance read.</div>` : '';
          breakdownHtml = `<div class="wallet-breakdown">${approxNote}${portfolio.topHoldings.map(h => `
            <div class="holding-row">
              <span class="holding-symbol">${h.symbol || '?'}</span>
              <span class="holding-amount">${h.amount.toLocaleString(undefined, {maximumFractionDigits: 4})}</span>
              <span class="holding-value">$${h.valueUsd.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
            </div>`).join('')}</div>`;
        }
      }

      return `
        <div class="wallet-card">
          <div class="addr" onclick="app.toggleWalletExpand('${w.address}')" style="cursor:pointer;">
            <span>${label}${w.nickname ? `<span class="wallet-addr-sub">${short}</span>` : ''}</span>
            <span class="wallet-card-actions">
              <button class="rename-btn" onclick="event.stopPropagation(); app.renameWallet('${w.address}','${w.chain}');" title="Rename">&#9998;</button>
              <button class="remove-btn" onclick="event.stopPropagation(); app.removeWallet('${w.address}','${w.chain}');" title="Remove">&times;</button>
            </span>
          </div>
          <div class="chain-tag">${w.chain} &middot; tap to see holdings</div>
          ${portfolioLine}
          ${breakdownHtml}
        </div>`;
    }).join('');
  },

  renderWalletFilters() {
    const row = document.getElementById('walletFilterRow');
    if (!row) return;
    if (this.wallets.length === 0) {
      row.innerHTML = '';
      return;
    }
    const allActive = !this.activeWalletFilter;
    row.innerHTML = `
      <button class="filter-chip ${allActive ? 'active' : ''}" onclick="app.setWalletFilter(null)">All</button>
      ${this.wallets.map(w => `
        <button class="filter-chip ${this.activeWalletFilter === w.address ? 'active' : ''}" onclick="app.setWalletFilter('${w.address}')">${this.walletLabel(w)}</button>
      `).join('')}
    `;
  },

  setWalletFilter(address) {
    this.activeWalletFilter = address;
    this.renderWalletFilters();
    this.renderWalletSignals();
  },

  async fetchWalletPortfolios() {
    const solanaWallets = this.wallets.filter(w => w.chain === 'solana');
    const evmWallets = this.wallets.filter(w => w.chain !== 'solana');

    await Promise.all([
      ...solanaWallets.map(async w => {
        const data = await this.fetchJson('wallet-portfolio', { address: w.address });
        if (data && !data.error) this.walletPortfolios[w.address] = data;
      }),
      ...evmWallets.map(async w => {
        const data = await this.fetchJson('wallet-portfolio-evm', { address: w.address, chain: w.chain });
        if (data && !data.error) this.walletPortfolios[w.address] = data;
      })
    ]);
    this.renderWallets();
  },

  // ---------- Watchlist / token risk ----------
  loadWatchlist() {
    try {
      const stored = localStorage.getItem('j7t_watchlist');
      this.watchlist = stored ? JSON.parse(stored) : [];
    } catch { this.watchlist = []; }
  },
  saveWatchlist() { localStorage.setItem('j7t_watchlist', JSON.stringify(this.watchlist)); this.markModified(); },

  async checkToken(prefilledMint, prefilledChain) {
    const input = document.getElementById('tokenInput');
    const chainSelect = document.getElementById('scanChainSelect');
    const chain = prefilledChain || (chainSelect ? chainSelect.value : 'solana');
    const address = prefilledMint || input.value.trim();
    if (!address) return;
    const resultEl = document.getElementById('tokenCheckResult');
    resultEl.innerHTML = '<div class="empty-note">Scanning...</div>';

    const data = chain === 'solana'
      ? await this.fetchJson('token-risk', { mint: address })
      : await this.fetchJson('token-risk-evm', { address, chain });

    if (data.error) {
      resultEl.innerHTML = `<div class="empty-note">Scan failed: ${data.error}</div>`;
      return;
    }
    // Normalize: Solana's function returns "mint", the EVM function
    // returns "address" - unify to "mint" for everything downstream.
    const mint = data.mint || data.address;
    this.renderTokenCheck(data, resultEl);

    this.watchlist.unshift({
      mint, chain, level: data.level, score: data.score,
      concentrationPct: data.concentrationPct, checkedAt: data.checkedAt,
      flags: data.flags, marketCap: data.market?.marketCap || null,
      pairAddress: data.market?.pairAddress || null,
      liquidityUsdAtScan: data.market?.liquidityUsd ?? null,
      priceUsdAtScan: data.market?.priceUsd ?? null
    });
    this.watchlist = this.watchlist.slice(0, 50);
    this.saveWatchlist();
    this.renderWatchlist();
    if (!prefilledMint) input.value = '';

    this.lastScannedMint = mint;
    const shortMint = `${mint.slice(0, 6)}...${mint.slice(-4)}`;
    this.setScannedChartTarget(data.market?.pairAddress, shortMint);
    if (this.isDesktop) this.renderHomeDashboard();

    if (chain === 'solana') {
      this.loadTokenNarrative(mint);
    } else {
      const narrativeEl = document.getElementById('tokenNarrativeSection');
      if (narrativeEl) narrativeEl.innerHTML = '<div class="empty-note">Narrative lookup is currently Solana-only.</div>';
    }
  },

  renderTokenCheck(data, el) {
    const flagsHtml = data.flags.map(f => `
      <div class="flag-item"><span class="flag-dot ${f.severity}"></span><span class="flag-text">${f.label}</span></div>
    `).join('');
    const mcapLine = data.market?.marketCap
      ? `<div class="market-line">Market cap: $${Number(data.market.marketCap).toLocaleString()}</div>` : '';
    const marketHtml = data.market ? `
      ${mcapLine}
      <div class="market-line">$${data.market.liquidityUsd.toLocaleString()} liquidity · $${data.market.volume24h.toLocaleString()} 24h vol · via ${data.market.dexId}</div>
    ` : '';
    el.innerHTML = `
      <div class="token-check-card">
        <div class="mint">${data.mint || data.address}</div>
        <span class="risk-badge ${data.level}">${data.level} risk</span>
        ${marketHtml}
        <div class="flag-list">${flagsHtml}</div>
        <div class="section-label" style="margin-top:14px;">Narrative</div>
        <div id="tokenNarrativeSection"><div class="empty-note">Loading token description...</div></div>
      </div>`;
  },

  async loadTokenNarrative(mint) {
    const el = document.getElementById('tokenNarrativeSection');
    if (!el) return;
    const data = await this.fetchJson('token-narrative', { mint });
    if (data.error || (!data.description && !data.twitter && !data.telegram && !data.website)) {
      el.innerHTML = '<div class="empty-note">No description or social links found in this token\'s on-chain metadata.</div>';
      return;
    }
    const links = [
      data.twitter ? `<a href="${data.twitter}" target="_blank" rel="noopener" class="narrative-link">Twitter/X &#8599;</a>` : '',
      data.telegram ? `<a href="${data.telegram}" target="_blank" rel="noopener" class="narrative-link">Telegram &#8599;</a>` : '',
      data.website ? `<a href="${data.website}" target="_blank" rel="noopener" class="narrative-link">Website &#8599;</a>` : ''
    ].filter(Boolean).join(' &middot; ');

    el.innerHTML = `
      ${data.description ? `<p class="narrative-description">${data.description}</p>` : '<div class="empty-note">No description written for this token.</div>'}
      ${links ? `<div class="narrative-links">${links}</div>` : ''}
      <div class="placeholder-note" style="margin-top:8px;">This is the deployer's own description of their token, not independent verification of any claim made in it (e.g. "sister coin to X") - treat it as marketing, not fact.</div>
    `;

    // Persist onto the matching watchlist entry so this is remembered
    // and available to the chat assistant later, not just shown once.
    const entry = this.watchlist.find(w => w.mint === mint);
    if (entry) {
      entry.description = data.description || null;
      entry.twitter = data.twitter || null;
      entry.telegram = data.telegram || null;
      entry.website = data.website || null;
      this.saveWatchlist();
    }
  },

  renderWatchlist() {
    const el = document.getElementById('watchlist');
    document.getElementById('watchlistSummary').textContent = `${this.watchlist.length} scanned`;
    if (this.watchlist.length === 0) {
      el.innerHTML = '<div class="empty-note">No tokens scanned yet.</div>';
      return;
    }
    el.innerHTML = this.watchlist.map((w, i) => {
      const short = w.mint.slice(0, 6) + '...' + w.mint.slice(-4);
      const chainTag = w.chain && w.chain !== 'solana' ? `<span class="wl-chain-tag">${w.chain}</span>` : '';

      // Prefer the live-refreshed market cap over the frozen scan-time
      // snapshot, since that's what was showing stale "yesterday" data.
      const hasLive = w.marketCapCurrent !== undefined && w.marketCapCurrent !== null;
      const mcap = hasLive
        ? `$${Number(w.marketCapCurrent).toLocaleString()} mcap (live, ${this.timeAgo(w.lastLiveCheckAt)})`
        : (w.marketCap ? `$${Number(w.marketCap).toLocaleString()} mcap (as of scan, ${this.timeAgo(w.checkedAt)})` : '');

      return `
        <div class="watchlist-card">
          <div class="wl-top">
            <span class="wl-mint" onclick="app.openWatchlistChart('${w.pairAddress || ''}')" style="cursor:pointer;">${short}${chainTag}</span>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="risk-badge ${w.level}">${w.level}</span>
              <button class="remove-btn" onclick="event.stopPropagation(); app.removeFromWatchlist(${i});" title="Remove">&times;</button>
            </div>
          </div>
          <div class="wl-time" onclick="app.openWatchlistChart('${w.pairAddress || ''}')" style="cursor:pointer;">${mcap}</div>
        </div>`;
    }).join('');
  },

  removeFromWatchlist(index) {
    this.watchlist.splice(index, 1);
    this.saveWatchlist();
    this.renderWatchlist();
    if (this.isDesktop) this.renderHomeDashboard();
  },

  timeAgo(iso) {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  },

  // ---------- Charts: opened externally on DexScreener, never embedded ----------
  // Embedding DexScreener's own site in an iframe proved unreliable (it's
  // not built for third-party embedding and can hang indefinitely instead
  // of failing clearly). Opening the real page in a new tab is slower by
  // one click but always works.
  setScannedChartTarget(pairAddress, label) {
    this.lastScannedPair = pairAddress || null;
    const btn = document.getElementById('lastScanChartBtn');
    if (btn) {
      btn.style.display = pairAddress ? 'block' : 'none';
      btn.textContent = pairAddress ? `Open ${label || 'scanned token'}'s chart \u2197` : '';
    }
  },

  openWatchlistChart(pairAddress) {
    if (!pairAddress) {
      alert('No trading pair was found for this token when it was scanned.');
      return;
    }
    window.open(`https://dexscreener.com/solana/${pairAddress}`, '_blank', 'noopener');
  },

  openChartExternal(useLastScanned) {
    const pairAddress = useLastScanned ? this.lastScannedPair : '58oqchx4ywmvkdwllzzbi4chocc2fqcuwbkwmihlyqo2';
    if (!pairAddress) {
      alert('No trading pair available for this token yet.');
      return;
    }
    window.open(`https://dexscreener.com/solana/${pairAddress}`, '_blank', 'noopener');
  },

  // ---------- Stage 3 prep: rules engine + position sizing (no execution) ----------
  async runRulesEngine() {
    const input = document.getElementById('rulesEngineInput');
    const mint = input.value.trim();
    if (!mint) return;
    const resultEl = document.getElementById('rulesEngineResult');
    resultEl.innerHTML = '<div class="empty-note">Evaluating against rules...</div>';

    const data = await this.fetchJson('rules-engine', { mint });
    if (data.error) {
      resultEl.innerHTML = `<div class="empty-note">Evaluation failed: ${data.error}</div>`;
      return;
    }

    const verdictClass = data.verdict === 'reject' ? 'high' : data.verdict === 'review' ? 'medium' : 'low';
    const allReasons = [
      ...data.reasons.reject.map(r => ({ text: r, severity: 'high' })),
      ...data.reasons.review.map(r => ({ text: r, severity: 'medium' })),
      ...data.reasons.pass.map(r => ({ text: r, severity: 'ok' }))
    ];

    resultEl.innerHTML = `
      <div class="token-check-card">
        <span class="risk-badge ${verdictClass}">${data.verdict.toUpperCase()}</span>
        <div class="flag-list">
          ${allReasons.map(r => `<div class="flag-item"><span class="flag-dot ${r.severity}"></span><span class="flag-text">${r.text}</span></div>`).join('')}
        </div>
        <div class="placeholder-note">This is a decision-support verdict only - nothing was bought, sold, or executed. Rules are fixed thresholds defined in the code, not adjustable from the UI yet.</div>
      </div>`;
  },

  calculatePositionSizing() {
    const portfolio = parseFloat(document.getElementById('sizingPortfolio').value) || 0;
    const riskPct = parseFloat(document.getElementById('sizingRiskPct').value) || 0;
    const stopPct = parseFloat(document.getElementById('sizingStopPct').value) || 0;
    const maxPositions = parseInt(document.getElementById('sizingMaxPositions').value, 10) || 1;
    const resultEl = document.getElementById('sizingResult');

    if (portfolio <= 0 || riskPct <= 0 || stopPct <= 0) {
      resultEl.innerHTML = '<div class="empty-note">Enter a portfolio value, risk %, and stop-loss % to calculate.</div>';
      return;
    }

    // Fixed-fractional position sizing: risking riskPct of the portfolio
    // per trade, sized so that hitting the stop-loss loses exactly that
    // much - not the whole position.
    const dollarRiskPerTrade = portfolio * (riskPct / 100);
    const positionSize = dollarRiskPerTrade / (stopPct / 100);
    const positionPctOfPortfolio = (positionSize / portfolio) * 100;
    const maxTotalExposure = positionSize * maxPositions;
    const maxExposurePct = (maxTotalExposure / portfolio) * 100;

    const warnings = [];
    if (stopPct < 15) {
      warnings.push('A stop-loss this tight is often smaller than normal memecoin volatility - you may get stopped out by ordinary price noise, not an actual problem with the token.');
    }
    if (positionPctOfPortfolio > 25) {
      warnings.push('This position size is a large share of your portfolio for a single token - consider whether that concentration is intentional.');
    }
    if (maxExposurePct > 100) {
      warnings.push(`If all ${maxPositions} positions were open at once, total exposure (${maxExposurePct.toFixed(0)}%) would exceed your entire portfolio - your risk-per-trade and position count aren't consistent with each other.`);
    }

    resultEl.innerHTML = `
      <div class="token-check-card">
        <div class="sizing-output-row"><span>Suggested position size</span><span class="sizing-output-value">$${positionSize.toLocaleString(undefined, {maximumFractionDigits: 2})} (${positionPctOfPortfolio.toFixed(1)}% of portfolio)</span></div>
        <div class="sizing-output-row"><span>Dollar risk if stopped out</span><span class="sizing-output-value">$${dollarRiskPerTrade.toLocaleString(undefined, {maximumFractionDigits: 2})}</span></div>
        <div class="sizing-output-row"><span>Max exposure at ${maxPositions} concurrent positions</span><span class="sizing-output-value">$${maxTotalExposure.toLocaleString(undefined, {maximumFractionDigits: 2})} (${maxExposurePct.toFixed(0)}%)</span></div>
        ${warnings.length ? `<div class="flag-list" style="margin-top:10px;">${warnings.map(w => `<div class="flag-item"><span class="flag-dot medium"></span><span class="flag-text">${w}</span></div>`).join('')}</div>` : ''}
        <div class="placeholder-note">Pure math based on your inputs - not a recommendation, and doesn't know anything about the specific token you'd apply it to.</div>
      </div>`;
  },

  // ---------- Devnet execution mechanics test (zero real value) ----------
  devnetKeypair: null,

  async generateDevnetWallet() {
    const resultEl = document.getElementById('devnetWalletResult');
    resultEl.innerHTML = '<div class="empty-note">Generating and requesting devnet SOL (may take a few seconds)...</div>';

    try {
      const res = await fetch(`${API_BASE}/devnet-wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestAirdrop: true })
      });
      const data = await res.json();
      if (data.error) {
        resultEl.innerHTML = `<div class="empty-note">Failed: ${data.error}</div>`;
        return;
      }

      this.devnetKeypair = { publicKey: data.publicKey, privateKey: data.privateKey };

      const airdropLine = data.airdropSignature
        ? `<div class="flag-item"><span class="flag-dot ok"></span><span class="flag-text">Received 1 devnet SOL (tx: ${data.airdropSignature.slice(0, 12)}...)</span></div>`
        : `<div class="flag-item"><span class="flag-dot medium"></span><span class="flag-text">${data.airdropError || 'No airdrop requested'}</span></div>`;

      resultEl.innerHTML = `
        <div class="token-check-card">
          <div class="mint">${data.publicKey}</div>
          <div class="flag-list">${airdropLine}</div>
          <div class="placeholder-note">${data.warning}</div>
        </div>`;

      document.getElementById('devnetExecuteForm').style.display = 'block';
    } catch (err) {
      resultEl.innerHTML = `<div class="empty-note">Failed: ${err.message}</div>`;
    }
  },

  async runDevnetTransfer() {
    if (!this.devnetKeypair) {
      alert('Generate a devnet wallet first.');
      return;
    }
    const toAddress = document.getElementById('devnetToAddress').value.trim();
    const amountSol = parseFloat(document.getElementById('devnetAmount').value);
    if (!toAddress || !amountSol) {
      alert('Enter a recipient address and amount.');
      return;
    }

    const resultEl = document.getElementById('devnetExecuteResult');
    resultEl.innerHTML = '<div class="empty-note">Building, signing, and sending transaction...</div>';

    try {
      const res = await fetch(`${API_BASE}/devnet-execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: this.devnetKeypair.privateKey, toAddress, amountSol })
      });
      const data = await res.json();
      if (data.error) {
        resultEl.innerHTML = `<div class="empty-note">Transaction failed: ${data.error}</div>`;
        return;
      }
      resultEl.innerHTML = `
        <div class="token-check-card">
          <span class="risk-badge low">CONFIRMED</span>
          <div class="market-line">${data.amountSol} SOL sent on devnet</div>
          <div class="market-line">Signature: ${data.signature.slice(0, 20)}...</div>
          <button class="launch-btn" onclick="window.open('${data.explorerUrl}', '_blank', 'noopener')">View on Solana Explorer (devnet) &#8599;</button>
        </div>`;
    } catch (err) {
      resultEl.innerHTML = `<div class="empty-note">Transaction failed: ${err.message}</div>`;
    }
  },

  // ---------- Alerts ----------
  loadAlerts() {
    try {
      const stored = localStorage.getItem('j7t_alerts');
      this.alerts = stored ? JSON.parse(stored) : [];
    } catch { this.alerts = []; }
  },
  saveAlerts() { localStorage.setItem('j7t_alerts', JSON.stringify(this.alerts.slice(0, 20))); this.markModified(); },

  addAlert(text) {
    this.alerts.unshift({ id: Date.now() + Math.random(), text, at: new Date().toISOString() });
    this.saveAlerts();
    this.renderAlerts();
  },

  dismissAlert(id) {
    this.alerts = this.alerts.filter(a => a.id !== id);
    this.saveAlerts();
    this.renderAlerts();
  },

  renderAlerts() {
    const banner = document.getElementById('alertsBanner');
    const list = document.getElementById('alertsList');
    if (this.alerts.length === 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'block';
    list.innerHTML = this.alerts.slice(0, 8).map(a => `
      <div class="alert-item">
        <span>${a.text}</span>
        <button class="alert-dismiss" onclick="app.dismissAlert(${a.id})">&times;</button>
      </div>`).join('');
  },

  // Re-checks the few most recently scanned watchlist tokens each refresh
  // cycle and raises an in-app alert if their risk level has changed since
  // last time. Capped to a small number to keep API usage reasonable.
  async checkWatchlistForRiskChanges() {
    const toRecheck = this.watchlist.slice(0, 10);
    for (const entry of toRecheck) {
      const chain = entry.chain || 'solana';
      const data = chain === 'solana'
        ? await this.fetchJson('token-risk', { mint: entry.mint })
        : await this.fetchJson('token-risk-evm', { address: entry.mint, chain });
      if (data.error || !data.level) continue;

      // Always refresh the "current" market snapshot regardless of
      // whether the risk level changed - this is what fixes stale market
      // cap/liquidity numbers being shown as if they were live.
      entry.marketCapCurrent = data.market?.marketCap ?? entry.marketCapCurrent ?? null;
      entry.liquidityUsdCurrent = data.market?.liquidityUsd ?? entry.liquidityUsdCurrent ?? null;
      entry.priceUsdCurrent = data.market?.priceUsd ?? entry.priceUsdCurrent ?? null;
      entry.lastLiveCheckAt = new Date().toISOString();

      if (data.level !== entry.level) {
        const short = entry.mint.slice(0, 6) + '...' + entry.mint.slice(-4);
        this.addAlert(`${short} risk changed: ${entry.level} → ${data.level}`);
        entry.level = data.level;
        entry.score = data.score;
      }
    }
    this.saveWatchlist();
    this.renderWatchlist();
  },

  // ---------- Track record: do past risk calls actually hold up? ----------
  // Compares each scan's liquidity at the time it was scanned against its
  // CURRENT liquidity. A large drop is real evidence something rugged; a
  // held/grown liquidity is evidence the token is still functioning. This
  // is cross-referenced against the risk level assigned at scan time to
  // see whether "high risk" calls actually preceded trouble, and whether
  // "low risk" calls held up - the closest thing to an accuracy check we
  // can build without a dedicated outcomes database.
  async runTrackRecordAnalysis() {
    const resultsEl = document.getElementById('trackRecordResults');
    const eligible = this.watchlist.filter(w => {
      const ageHours = (Date.now() - new Date(w.checkedAt).getTime()) / 3600000;
      return ageHours >= 6 && w.liquidityUsdAtScan !== null && w.liquidityUsdAtScan !== undefined;
    }).slice(0, 15);

    if (eligible.length === 0) {
      resultsEl.innerHTML = '<div class="empty-note">No scans old enough yet (need at least 6 hours) with liquidity data logged. Scan some tokens and check back later.</div>';
      return;
    }

    resultsEl.innerHTML = '<div class="empty-note">Running analysis...</div>';

    const outcomes = [];
    for (const entry of eligible) {
      const chain = entry.chain || 'solana';
      const data = chain === 'solana'
        ? await this.fetchJson('token-risk', { mint: entry.mint })
        : await this.fetchJson('token-risk-evm', { address: entry.mint, chain });
      const currentLiquidity = data?.market?.liquidityUsd;
      if (currentLiquidity === undefined || currentLiquidity === null || !entry.liquidityUsdAtScan) continue;

      const pctChange = entry.liquidityUsdAtScan > 0
        ? ((currentLiquidity - entry.liquidityUsdAtScan) / entry.liquidityUsdAtScan) * 100
        : null;
      if (pctChange === null) continue;

      let outcome;
      if (pctChange <= -80) outcome = 'rugged';
      else if (pctChange >= -20) outcome = 'healthy';
      else outcome = 'declined';

      outcomes.push({ mint: entry.mint, level: entry.level, outcome, pctChange, checkedAt: entry.checkedAt });
    }

    this.renderTrackRecordResults(outcomes);
  },

  renderTrackRecordResults(outcomes) {
    const resultsEl = document.getElementById('trackRecordResults');
    if (outcomes.length === 0) {
      resultsEl.innerHTML = '<div class="empty-note">Could not compare liquidity for any eligible scans - try again later.</div>';
      return;
    }

    const highRugged = outcomes.filter(o => o.level === 'high' && o.outcome === 'rugged').length;
    const highHealthy = outcomes.filter(o => o.level === 'high' && o.outcome === 'healthy').length;
    const lowRugged = outcomes.filter(o => o.level === 'low' && o.outcome === 'rugged').length;
    const lowHealthy = outcomes.filter(o => o.level === 'low' && o.outcome === 'healthy').length;

    const summaryHtml = `
      <div class="track-record-summary">
        <div class="tr-stat"><div class="tr-stat-value" style="color:var(--red);">${highRugged}</div><div class="tr-stat-label">High-risk calls that later lost 80%+ liquidity (correct call)</div></div>
        <div class="tr-stat"><div class="tr-stat-value" style="color:var(--amber);">${highHealthy}</div><div class="tr-stat-label">High-risk calls that are still healthy (possibly overcautious)</div></div>
        <div class="tr-stat"><div class="tr-stat-value" style="color:var(--red);">${lowRugged}</div><div class="tr-stat-label">Low-risk calls that later lost 80%+ liquidity (missed - concerning)</div></div>
        <div class="tr-stat"><div class="tr-stat-value" style="color:var(--green);">${lowHealthy}</div><div class="tr-stat-label">Low-risk calls that are still healthy (correct call)</div></div>
      </div>
    `;

    const listHtml = outcomes.map(o => {
      const short = o.mint.slice(0, 6) + '...' + o.mint.slice(-4);
      const outcomeColor = o.outcome === 'rugged' ? 'high' : o.outcome === 'healthy' ? 'low' : 'medium';
      return `
        <div class="track-record-row">
          <span class="wl-mint">${short}</span>
          <span class="risk-badge ${o.level}">flagged ${o.level}</span>
          <span class="risk-badge ${outcomeColor}">${o.outcome} (${o.pctChange >= 0 ? '+' : ''}${o.pctChange.toFixed(0)}% liq)</span>
        </div>`;
    }).join('');

    resultsEl.innerHTML = summaryHtml + `<div class="section-label" style="margin-top:14px;">Individual results</div>` + listHtml +
      `<div class="placeholder-note">Based on liquidity change since each scan, not a perfect outcome measure - a large liquidity drop usually means real trouble, but can occasionally reflect normal market conditions too. Only scans at least 6 hours old are included.</div>`;
  },

  // ---------- Trend history (for time-based synthesis in chat) ----------
  loadTrendHistory() {
    try {
      const stored = localStorage.getItem('j7t_trend_history');
      this.trendHistory = stored ? JSON.parse(stored) : [];
    } catch { this.trendHistory = []; }
  },

  saveTrendSnapshot(trends) {
    if (!trends || trends.length === 0) return;
    this.trendHistory.push({ at: new Date().toISOString(), trends: trends.slice(0, 8) });
    // Keep a bounded but useful window - roughly the last couple of days
    // at a 5-minute refresh cadence would be too much, so sample sparsely.
    this.trendHistory = this.trendHistory.slice(-100);
    localStorage.setItem('j7t_trend_history', JSON.stringify(this.trendHistory));
  },

  // ---------- Refresh: wallets, news, trends ----------
  async refresh() {
    this.setStatus(true, 'SYNCING');
    try {
      const [walletSignals, newsData, priceData, trendingData] = await Promise.all([
        this.fetchWalletSignals(),
        this.fetchJson('news'),
        this.fetchJson('price'),
        this.fetchJson('trending-tokens')
      ]);

      this.walletSignals = walletSignals.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      this.renderWalletSignals();

      this.newsItems = newsData.news || [];
      this.trends = newsData.trending || [];
      this.renderNews();
      this.renderTrends();
      this.saveTrendSnapshot(this.trends);

      if (priceData && !priceData.error) {
        this.livePrice = priceData;
      }

      if (trendingData && !trendingData.error) {
        this.trendingTokens = trendingData.tokens || [];
        this.renderTrendingTokens();
      }

      document.getElementById('updatesSummary').textContent = `${this.newsItems.length} new`;
      this.setStatus(true, 'LIVE');

      // Don't block the main refresh on alert re-checks
      this.checkWatchlistForRiskChanges();
      this.fetchWalletPortfolios();
      if (this.isDesktop) this.renderHomeDashboard();
    } catch (err) {
      console.error('Refresh failed:', err);
      this.setStatus(false, 'ERROR');
    }
  },

  async fetchWalletSignals() {
    const byChain = {};
    this.wallets.forEach(w => {
      if (!byChain[w.chain]) byChain[w.chain] = [];
      byChain[w.chain].push(w.address);
    });
    const results = await Promise.all(
      Object.entries(byChain).map(async ([chain, addrs]) => {
        const fn = WALLET_ENDPOINTS[chain];
        if (!fn) return [];
        const data = await this.fetchJson(fn, { addrs: addrs.join(',') });
        return data.signals || [];
      })
    );
    return results.flat();
  },

  async fetchJson(fnName, params = {}) {
    const bustedParams = { ...params, _t: Date.now() };
    const query = new URLSearchParams(bustedParams).toString();
    const url = `${API_BASE}/${fnName}${query ? '?' + query : ''}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      return await res.json();
    } catch (err) {
      console.error(`Fetch failed for ${fnName}:`, err.message);
      return {};
    }
  },

  renderWalletSignals() {
    const log = document.getElementById('walletSignalLog');
    const filtered = this.activeWalletFilter
      ? this.walletSignals.filter(s => s.sourceAddress === this.activeWalletFilter)
      : this.walletSignals;
    if (filtered.length === 0) {
      log.innerHTML = this.activeWalletFilter
        ? '<div class="empty-note">No activity yet for this wallet.</div>'
        : '<div class="empty-note">No wallet activity yet.</div>';
      return;
    }
    log.innerHTML = filtered.slice(0, 25).map(s => {
      const tappable = !!s.boughtMint;
      const actions = tappable ? `
        <div class="signal-actions">
          <button class="signal-action-btn" onclick="event.stopPropagation(); app.checkToken('${s.boughtMint}', 'solana'); app.goToSection('watchlist');">Analyze risk</button>
          <button class="signal-action-btn" onclick="event.stopPropagation(); window.open('https://dexscreener.com/solana/${s.boughtMint}', '_blank', 'noopener');">View chart &#8599;</button>
        </div>` : '';
      return `
      <div class="signal-row">
        <span class="signal-tag wallet">wallet</span>
        <div style="flex:1;">
          <div class="signal-title">${s.title}</div>
          <div class="signal-sub">${s.subtitle || ''}</div>
          ${actions}
        </div>
        <div class="signal-time">${this.timeAgo(s.timestamp)}</div>
      </div>`;
    }).join('');
  },

  renderNews() {
    const list = document.getElementById('newsList');
    if (this.newsItems.length === 0) {
      list.innerHTML = '<div class="empty-note">No headlines yet.</div>';
      return;
    }
    list.innerHTML = this.newsItems.map(n => `
      <div class="news-item">
        <span class="cat ${n.category}">${n.category}</span>
        <div class="title">${n.title}</div>
        <div class="meta">${n.subtitle} · ${this.timeAgo(n.timestamp)}</div>
      </div>`).join('');
  },

  renderTrends() {
    const list = document.getElementById('trendList');
    if (this.trends.length === 0) {
      list.innerHTML = '<div class="empty-note">No trend data yet.</div>';
      return;
    }
    const max = Math.max(...this.trends.map(t => t.count));
    list.innerHTML = this.trends.map(t => `
      <div class="trend-item">
        <div class="trend-name">${t.name}</div>
        <div class="trend-bar-wrap"><div class="trend-bar" style="width:${(t.count / max) * 100}%"></div></div>
        <div class="trend-count">${t.count} mentions</div>
      </div>`).join('');
  },

  renderTrendingTokens() {
    const list = document.getElementById('trendingTokensList');
    if (!list) return;
    if (this.trendingTokens.length === 0) {
      list.innerHTML = '<div class="empty-note">No trending token data yet.</div>';
      return;
    }
    list.innerHTML = this.trendingTokens.map(t => {
      const changeClass = (t.priceChange24h || 0) >= 0 ? 'ok' : 'high';
      const changeSign = (t.priceChange24h || 0) >= 0 ? '+' : '';
      return `
        <div class="trending-token-item" onclick="app.checkToken('${t.address}', 'solana'); app.goToSection('watchlist');">
          <div class="tt-left">
            <div class="tt-symbol">${t.symbol || '?'}</div>
            <div class="tt-name">${t.name || ''}</div>
          </div>
          <div class="tt-right">
            <div class="tt-change ${changeClass}">${changeSign}${(t.priceChange24h || 0).toFixed(1)}%</div>
            <div class="tt-vol">$${Number(t.volume24h || 0).toLocaleString()} vol</div>
          </div>
        </div>`;
    }).join('');
  },

  setStatus(online, label) {
    document.getElementById('statusDot').classList.toggle('offline', !online);
    document.getElementById('statusText').textContent = label;
    const dotDesktop = document.getElementById('statusDotDesktop');
    const textDesktop = document.getElementById('statusTextDesktop');
    if (dotDesktop) dotDesktop.classList.toggle('offline', !online);
    if (textDesktop) textDesktop.textContent = label;
  },

  // ---------- Two-way sync (Netlify Blobs, keyed by sync code) ----------
  // Whole-state, last-write-wins sync - not a field-level merge. Each
  // device tracks a lastModified timestamp; whichever device has the
  // newer one "wins" and the other adopts its full state. This is the
  // practical version of two-way sync for a single person using two
  // devices, not a full CRDT - if you genuinely edit on both devices in
  // the same few seconds before a sync completes, the older change can
  // be overwritten. For normal use (editing on one device at a time)
  // this reliably keeps both devices caught up with each other.
  // ---------- Push notifications (real, reach you even with tab closed) ----------
  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      return await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      console.error('Service worker registration failed:', err.message);
      return null;
    }
  },

  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  },

  async checkPushStatus() {
    const statusEl = document.getElementById('pushStatusText');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      if (statusEl) statusEl.textContent = 'Not supported in this browser';
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (statusEl) statusEl.textContent = sub ? 'Enabled on this device' : 'Not enabled';
    const btn = document.getElementById('pushToggleBtn');
    if (btn) btn.textContent = sub ? 'Disable push notifications' : 'Enable push notifications';
  },

  async togglePushNotifications() {
    const reg = await navigator.serviceWorker.getRegistration() || await this.registerServiceWorker();
    if (!reg) { alert('Service workers aren\'t supported in this browser.'); return; }

    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
      await fetch(`${API_BASE}/push-subscribe?code=${this.syncCode}`, { method: 'DELETE' });
      this.checkPushStatus();
      return;
    }

    if (Notification.permission === 'denied') {
      alert('Notifications are blocked for this site in your browser settings. Enable them there first, then try again.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const keyData = await this.fetchJson('vapid-public-key');
    if (!keyData?.publicKey) {
      alert('Push notifications aren\'t configured on this deployment yet (missing VAPID keys in Netlify environment variables).');
      return;
    }

    try {
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(keyData.publicKey)
      });
      await fetch(`${API_BASE}/push-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: this.syncCode, subscription })
      });
      this.checkPushStatus();
    } catch (err) {
      console.error('Push subscription failed:', err.message);
      alert('Could not enable push notifications: ' + err.message);
    }
  },

  initSync() {
    let code = localStorage.getItem('j7t_sync_code');
    if (!code) {
      code = this.generateSyncCode();
      localStorage.setItem('j7t_sync_code', code);
    }
    this.syncCode = code;

    const storedModified = localStorage.getItem('j7t_last_modified');
    this.lastModified = storedModified ? parseInt(storedModified, 10) : Date.now();

    this.renderSyncCodeDisplay();
    this.performSync(); // pull-or-push on load
    setInterval(() => this.performSync(), 60 * 1000);
  },

  generateSyncCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  },

  markModified() {
    this.lastModified = Date.now();
    localStorage.setItem('j7t_last_modified', String(this.lastModified));
    // Debounce pushes so rapid successive changes (e.g. scanning several
    // tokens back to back) don't each trigger a separate network call.
    clearTimeout(this.syncPushTimer);
    this.syncPushTimer = setTimeout(() => this.performSync(), 3000);
  },

  buildSyncPayload() {
    return {
      lastModified: this.lastModified,
      wallets: this.wallets,
      watchlist: this.watchlist,
      alerts: this.alerts,
      chatHistory: this.chatHistory
    };
  },

  async performSync() {
    if (!this.syncCode || this.syncInProgress) return;
    this.syncInProgress = true;
    try {
      const res = await fetch(`${API_BASE}/sync?code=${this.syncCode}`, { cache: 'no-store' });
      const result = await res.json();
      const remote = result?.data;

      if (remote && remote.lastModified > this.lastModified) {
        // Remote is newer - adopt it.
        this.wallets = remote.wallets || [];
        this.watchlist = remote.watchlist || [];
        this.alerts = remote.alerts || [];
        this.chatHistory = remote.chatHistory || [];
        this.lastModified = remote.lastModified;

        localStorage.setItem('j7t_wallets', JSON.stringify(this.wallets));
        localStorage.setItem('j7t_watchlist', JSON.stringify(this.watchlist));
        localStorage.setItem('j7t_alerts', JSON.stringify(this.alerts));
        localStorage.setItem('j7t_chat_history', JSON.stringify(this.chatHistory));
        localStorage.setItem('j7t_last_modified', String(this.lastModified));

        this.renderWallets();
        this.renderWalletFilters();
        this.renderWatchlist();
        this.renderAlerts();
        this.renderChatHistory();
        this.refresh();
        if (this.isDesktop) this.renderHomeDashboard();
      } else {
        // Local is newer (or nothing remote yet) - push it up.
        await fetch(`${API_BASE}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: this.syncCode, data: this.buildSyncPayload() })
        });
      }
      this.setSyncStatus('synced');
    } catch (err) {
      console.error('Sync failed:', err.message);
      this.setSyncStatus('error');
    } finally {
      this.syncInProgress = false;
    }
  },

  setSyncStatus(status) {
    const el = document.getElementById('syncStatusText');
    if (!el) return;
    el.textContent = status === 'synced' ? 'Synced' : status === 'error' ? 'Sync error' : 'Syncing...';
  },

  renderSyncCodeDisplay() {
    const el = document.getElementById('syncCodeDisplay');
    if (el) el.textContent = this.syncCode;
  },

  copySyncCode() {
    navigator.clipboard.writeText(this.syncCode).then(() => alert('Sync code copied.'));
  },

  joinSyncCode() {
    const input = document.getElementById('joinSyncInput');
    const newCode = input.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,10}$/.test(newCode)) {
      alert('That doesn\'t look like a valid sync code (letters/numbers, 6-10 characters).');
      return;
    }
    if (!confirm('This will replace your local data with whatever is stored under that code, if anything exists there yet. Continue?')) return;
    this.syncCode = newCode;
    localStorage.setItem('j7t_sync_code', newCode);
    this.lastModified = 0; // force pulling remote state if it exists
    localStorage.setItem('j7t_last_modified', '0');
    this.renderSyncCodeDisplay();
    input.value = '';
    this.performSync();
  },

  // ---------- Chat persistence ----------
  loadChatHistory() {
    try {
      const stored = localStorage.getItem('j7t_chat_history');
      this.chatHistory = stored ? JSON.parse(stored) : [];
    } catch { this.chatHistory = []; }
  },

  saveChatHistory() {
    const trimmed = this.chatHistory.slice(-60);
    localStorage.setItem('j7t_chat_history', JSON.stringify(trimmed));
    this.chatHistory = trimmed;
    this.markModified();
  },

  renderChatHistory() {
    const log = document.getElementById('chatLog');
    log.innerHTML = '';
    this.chatHistory.forEach(msg => this.appendChatBubble(msg.role, msg.content));
    this.updateChatControlsVisibility();
  },

  // ---------- Chat (with full history/context + trend history) ----------
  async sendChat(spokenText, isVoice) {
    const input = document.getElementById('chatInput');
    const message = spokenText || input.value.trim();
    if (!message) return;
    input.value = '';

    this.appendChatBubble('user', message);
    const thinkingEl = this.appendChatBubble('assistant', 'Thinking...', true);

    // Condense trend history into a compact time series so the model can
    // reason about how things have shifted, not just the current snapshot.
    const trendSeries = this.trendHistory.slice(-20).map(snap => ({
      at: snap.at,
      top: snap.trends.slice(0, 4).map(t => `${t.name}(${t.count})`).join(', ')
    }));

    const walletsWithPortfolio = this.wallets.map(w => ({
      ...w,
      portfolio: this.walletPortfolios[w.address] || null
    }));

    const context = {
      livePrice: this.livePrice,
      currentlyTrendingSolanaTokens: this.trendingTokens,
      watchedWallets: walletsWithPortfolio,
      watchlist: this.watchlist,
      walletSignals: this.walletSignals.slice(0, 50),
      newsItems: this.newsItems,
      trendingTopics: this.trends,
      trendHistoryOverTime: trendSeries
    };

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, context, history: this.chatHistory })
      });
      const data = await res.json();
      thinkingEl.remove();

      if (data.error) {
        this.appendChatBubble('assistant', `Error: ${data.error}`);
        if (isVoice) this.voiceConversationActive = false;
        return;
      }
      const cleanReply = this.stripMarkdown(data.reply);
      this.appendChatBubble('assistant', cleanReply);

      // For voice-driven exchanges, automatically listen for a follow-up
      // once the reply finishes speaking - this is the actual
      // "conversational" behavior: only the first turn needs the wake
      // word, everything after flows naturally until you go quiet or
      // stop it yourself.
      if (isVoice && this.voiceConversationActive) {
        this.speak(cleanReply, () => {
          if (this.voiceConversationActive && this.voiceMode === 'idle') {
            this.startCommandListening();
          }
        });
      } else {
        this.speak(cleanReply);
      }

      this.chatHistory.push({ role: 'user', content: message });
      this.chatHistory.push({ role: 'assistant', content: cleanReply });
      this.saveChatHistory();
      this.updateChatControlsVisibility();
    } catch (err) {
      thinkingEl.remove();
      this.appendChatBubble('assistant', `Error: ${err.message}`);
      if (isVoice) this.voiceConversationActive = false;
    }
  },

  // Safety net: strips markdown symbols even if the model doesn't fully
  // follow the plain-text instruction, so voice output never reads out
  // literal asterisks, dashes, colons-as-headers, etc.
  stripMarkdown(text) {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/^[-•]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/`{1,3}/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, '. ')
      .trim();
  },

  appendChatBubble(role, text, isThinking = false) {
    const log = document.getElementById('chatLog');
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}${isThinking ? ' thinking' : ''}`;
    bubble.textContent = text;
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  },

  // ---------- Voice input / output ----------
  // ---------- Voice: single shared recognition instance ----------
  // Previously this used two separate SpeechRecognition objects (one for
  // the wake word, one for manual voice input). Browsers generally only
  // allow one active recognition session at a time, so whichever one
  // grabbed the mic first silently blocked the other - this was the real
  // cause of "both mic input and wake word broken." Now there's a single
  // instance with a mode flag, so they properly hand off to each other.
  voiceMode: 'idle', // 'idle' | 'wake' | 'command'
  wakeWordWanted: false,
  pendingAction: null, // 'startCommand' | null - what to do once the CURRENT session has fully torn down
  commandCaptured: false, // did the current command session actually hear something
  voiceConversationActive: false, // are we in a hands-free back-and-forth right now

  setupSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('SpeechRecognition not supported in this browser.');
      return;
    }
    this.recognition = new SR();
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      const transcript = last[0].transcript.toLowerCase();

      if (this.voiceMode === 'wake') {
        this.handleWakePhrase(transcript);
      } else if (this.voiceMode === 'command' && last.isFinal) {
        this.commandCaptured = true;
        document.getElementById('chatInput').value = transcript;
        this.sendChat(transcript, true);
      }
    };

    // onend is the reliable signal that the browser has FULLY torn down
    // the previous session - using it (rather than a fixed setTimeout
    // guess) to trigger the next step is what actually fixes the race
    // where the wake phrase itself could leak through as if it were the
    // real question.
    this.recognition.onend = () => {
      const wasCommandWithNoSpeech = this.voiceMode === 'command' && !this.commandCaptured;
      this.voiceMode = 'idle';
      document.getElementById('voiceBtn').classList.remove('listening');
      document.getElementById('voiceLabel').textContent = 'voice';

      if (this.pendingAction === 'startCommand') {
        this.pendingAction = null;
        this.startCommandListening();
        return;
      }

      // Silence timeout with nothing said - exit any conversational loop
      // rather than sitting there having accomplished nothing.
      if (wasCommandWithNoSpeech) {
        this.voiceConversationActive = false;
      }

      if (this.wakeWordWanted) {
        setTimeout(() => this.startWakeListening(), 350);
      }
    };

    this.recognition.onerror = (e) => {
      this.voiceMode = 'idle';
      document.getElementById('voiceBtn').classList.remove('listening');
      document.getElementById('voiceLabel').textContent = 'voice';

      if (e.error === 'no-speech') return; // expected/frequent, not a real error
      if (e.error === 'not-allowed' || e.error === 'permission-denied') {
        alert('Microphone permission was denied. Check Chrome\'s site settings (tap the lock icon in the address bar) and allow microphone access for this site.');
      } else if (e.error === 'audio-capture') {
        alert('No microphone was found on this device.');
      } else {
        console.error('Speech recognition error:', e.error);
      }
      this.voiceConversationActive = false;
    };
  },

  startWakeListening() {
    if (!this.recognition || this.voiceMode !== 'idle') return;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.voiceMode = 'wake';
    try { this.recognition.start(); } catch (e) { /* already running */ }
  },

  // Actually starts the one-shot command listener. Only ever called once
  // we know for certain no other session is active (either voiceMode was
  // already 'idle', or onend just confirmed the previous session closed).
  startCommandListening() {
    if (!this.recognition) return;
    this.commandCaptured = false;
    this.recognition.continuous = false;
    this.recognition.interimResults = false;
    this.voiceMode = 'command';
    document.getElementById('voiceBtn').classList.add('listening');
    document.getElementById('voiceLabel').textContent = 'listening...';
    try {
      this.recognition.start();
    } catch (e) {
      // Session wasn't actually torn down yet despite our checks - retry
      // shortly rather than silently failing.
      setTimeout(() => { try { this.recognition.start(); } catch (e2) { /* ignore */ } }, 300);
    }
  },

  toggleVoiceInput() {
    if (!this.recognition) {
      alert('Voice input is not supported in this browser. Try Chrome.');
      return;
    }
    // Barge-in: if the AI is mid-reply, tapping the mic should interrupt
    // it immediately rather than talking over the new question.
    if (this.synth && this.synth.speaking) {
      this.synth.cancel();
    }
    if (this.voiceMode === 'command') {
      this.voiceConversationActive = false; // manual stop ends any auto-loop
      this.recognition.stop();
      return;
    }
    this.voiceConversationActive = true;
    if (this.voiceMode === 'wake') {
      // Don't start a new session here - let onend (triggered by this
      // stop) drive the transition once the wake session is truly closed.
      this.pendingAction = 'startCommand';
      this.recognition.stop();
      return;
    }
    if (this.voiceMode === 'idle') {
      this.startCommandListening();
    }
  },

  speak(text, onSpeechEnd) {
    if (!this.synth) {
      if (onSpeechEnd) onSpeechEnd();
      return;
    }
    this.synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onerror = (e) => {
      console.error('Speech synthesis error:', e.error);
      if (onSpeechEnd) onSpeechEnd();
    };
    if (onSpeechEnd) utterance.onend = onSpeechEnd;
    this.synth.speak(utterance);
  },

  // ---------- Wake word + voice quick-commands ----------
  handleWakePhrase(transcript) {
    if (transcript.includes('j7 portfolio') || transcript.includes('j seven portfolio')) {
      this.goToSection('wallets');
      document.getElementById('walletsCardHeader').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }
    if (transcript.includes('j7 next card') || transcript.includes('j seven next card')) {
      this.cycleNextSection();
      return true;
    }
    if (transcript.includes('j7 clear logs') || transcript.includes('j seven clear logs')) {
      this.clearLogs();
      return true;
    }
    if (transcript.includes('j7 activate') || transcript.includes('j seven activate')) {
      // Don't call toggleVoiceInput() directly here - a fresh interim
      // result can fire again before the browser has actually finished
      // tearing down this wake session, which was the root cause of the
      // wake phrase itself sometimes leaking through as if it were the
      // real question. Instead, mark what should happen next and let
      // onend (the reliable "fully stopped" signal) trigger it.
      this.voiceConversationActive = true;
      this.pendingAction = 'startCommand';
      this.recognition.stop();
      return true;
    }
    return false;
  },
  // ---------- PAPER TRADING ----------

  async paperTradingRequest(method = 'GET', payload = null) {
    const secretInput = document.getElementById('paperSecretInput');
    const secret = secretInput?.value.trim();

    if (!secret) {
      throw new Error('Masukkan secret Paper Trading terlebih dahulu.');
    }

    let accountId = localStorage.getItem('j7-paper-account');

    if (!accountId) {
      accountId = 'paper_' +
        (crypto.randomUUID
          ? crypto.randomUUID().replace(/-/g, '')
          : Date.now().toString(36) + Math.random().toString(36).slice(2));

      localStorage.setItem('j7-paper-account', accountId);
    }

    const options = {
      method,
      headers: {
        'Authorization': 'Bearer ' + secret,
        'Content-Type': 'application/json'
      }
    };

    let url = '/.netlify/functions/paper-trading';

    if (method === 'GET') {
      url += '?accountId=' + encodeURIComponent(accountId);
    } else {
      options.body = JSON.stringify({
        ...payload,
        accountId
      });
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Permintaan Paper Trading gagal.');
    }

    return data;
  },

  async loadPaperTrading() {
    const status = document.getElementById('paperStatus');

    try {
      status.textContent = 'Menghubungkan akun simulasi...';

      const data = await this.paperTradingRequest('GET');

      this.renderPaperTrading(data);

      status.textContent = 'Terhubung — mode simulasi aktif.';
    } catch (error) {
      status.textContent = error.message;
    }
  },

  async paperBuy() {
    const token = document.getElementById('paperTokenInput').value.trim();
    const amountUsd = Number(
      document.getElementById('paperAmountInput').value
    );
    const priceUsd = Number(
      document.getElementById('paperPriceInput').value
    );

    if (!token || !Number.isFinite(amountUsd) ||
        !Number.isFinite(priceUsd)) {
      alert('Isi nama token, modal USD, dan harga token dengan benar.');
      return;
    }

    try {
      const data = await this.paperTradingRequest('POST', {
        action: 'buy',
        token,
        amountUsd,
        priceUsd
      });

      alert(data.message || 'Pembelian simulasi berhasil.');

      await this.loadPaperTrading();
    } catch (error) {
      alert(error.message);
    }
  },

  async paperSell(positionId) {
    const priceInput = document.getElementById('paperPriceInput');
    const priceUsd = Number(priceInput.value);

    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      alert('Masukkan harga jual simulasi yang valid.');
      return;
    }

    try {
      const data = await this.paperTradingRequest('POST', {
        action: 'sell',
        positionId,
        priceUsd
      });

      alert(
        'Posisi ditutup secara simulasi. P/L: $' +
        Number(data.pnlUsd).toFixed(2)
      );

      await this.loadPaperTrading();
    } catch (error) {
      alert(error.message);
    }
  },

  renderPaperTrading(data) {
    const balance = document.getElementById('paperBalance');
    const positionsBox = document.getElementById('paperPositions');
    const historyBox = document.getElementById('paperHistory');

    balance.textContent =
      '$' + Number(data.balanceUsd).toFixed(2);

    if (!data.positions || data.positions.length === 0) {
      positionsBox.textContent = 'Belum ada posisi terbuka.';
    } else {
      positionsBox.replaceChildren();

      data.positions.forEach(position => {
        const row = document.createElement('div');
        row.style.marginBottom = '12px';

        const info = document.createElement('p');
        info.textContent =
          position.token +
          ' | Modal: $' + Number(position.investedUsd).toFixed(2) +
          ' | Harga masuk: $' +
          Number(position.entryPriceUsd).toFixed(8);

        const button = document.createElement('button');
        button.textContent = 'Jual simulasi';

        button.addEventListener('click', () => {
          this.paperSell(position.id);
        });

        row.append(info, button);
        positionsBox.appendChild(row);
      });
    }

    if (!data.history || data.history.length === 0) {
      historyBox.textContent = 'Belum ada transaksi.';
    } else {
      historyBox.replaceChildren();

      data.history.slice().reverse().forEach(item => {
        const row = document.createElement('p');

        row.textContent =
          (item.action || 'Transaksi') +
          ' | ' + (item.token || '-') +
          ' | ' +
          '$' + Number(
            item.amountUsd ?? item.proceedsUsd ?? 0
          ).toFixed(2);

        historyBox.appendChild(row);
      });
    }
  },

  // ---------- AKHIR PAPER TRADING ----------
  toggleWakeWord(enabled) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const box = document.getElementById('wakeWordToggle');
    if (!SR) {
      alert('Wake word requires Chrome (SpeechRecognition not supported here).');
      if (box) box.checked = false;
      return;
    }
    if (box) box.checked = enabled;

    this.wakeWordWanted = enabled;
    if (enabled) {
      this.startWakeListening();
    } else if (this.voiceMode === 'wake') {
      this.recognition.stop();
    }
  }
};

document.addEventListener('DOMContentLoaded', () => app.init());
