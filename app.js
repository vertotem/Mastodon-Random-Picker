import { parseMastodonUrl, formatDate, downloadJson } from './utils.js';
import { icons } from './icons.js';

// State management
let state = {
  mode: 'url',
  urlInput: '',
  showTutorial: false,
  loading: false,
  fetchCount: 0,
  error: null,
  currentAccount: null,
  allStatuses: [],
  currentStatus: null,
  viewedIds: new Set(),
  customEmojis: [], // Store custom emojis for current instance
};

// Helper to load history
const loadHistory = (accountId) => {
  const storageKey = `seen_statuses_${accountId}`;
  const savedHistory = localStorage.getItem(storageKey);
  if (savedHistory) {
    state.viewedIds = new Set(JSON.parse(savedHistory));
  } else {
    state.viewedIds = new Set();
  }
};

// Helper to save history
const saveHistory = (accountId, ids) => {
  const storageKey = `seen_statuses_${accountId}`;
  localStorage.setItem(storageKey, JSON.stringify(Array.from(ids)));
};

// Extract domain from account URL
const extractDomainFromAccount = (account) => {
  try {
    if (account.url) {
      const url = new URL(account.url);
      return url.hostname;
    }
    // Fallback: try to extract from acct field (format: username@domain)
    if (account.acct && account.acct.includes('@')) {
      const parts = account.acct.split('@');
      if (parts.length > 1) {
        return parts[parts.length - 1];
      }
    }
    return null;
  } catch (e) {
    return null;
  }
};

// Fetch custom emojis from instance
const fetchCustomEmojis = async (domain) => {
  if (!domain) return;
  
  try {
    const emojiUrl = `https://${domain}/api/v1/custom_emojis`;
    const emojiRes = await fetch(emojiUrl);
    if (emojiRes.ok) {
      const emojis = await emojiRes.json();
      state.customEmojis = emojis || [];
    } else {
      state.customEmojis = [];
    }
  } catch (e) {
    console.warn('Failed to fetch custom emojis:', e);
    state.customEmojis = [];
  }
};

// Replace custom emoji shortcodes with images in content
const replaceCustomEmojis = (content) => {
  if (!state.customEmojis || state.customEmojis.length === 0) {
    return content;
  }
  
  let processedContent = content;
  
  // Replace each emoji shortcode (format: :shortcode:)
  state.customEmojis.forEach(emoji => {
    const regex = new RegExp(`:${emoji.shortcode}:`, 'g');
    const emojiImg = `<img src="${emoji.static_url || emoji.url}" alt=":${emoji.shortcode}:" class="custom-emoji inline-block h-5 w-5 align-text-bottom" title=":${emoji.shortcode}:">`;
    processedContent = processedContent.replace(regex, emojiImg);
  });
  
  return processedContent;
};

// Handle URL Fetch (Recursive)
const handleFetch = async (e) => {
  e.preventDefault();
  state.error = null;
  state.loading = true;
  state.allStatuses = [];
  state.fetchCount = 0;
  state.currentStatus = null;
  state.currentAccount = null;
  render();

  const parsed = parseMastodonUrl(state.urlInput);
  if (!parsed) {
    state.error = '无效的 Mastodon 用户链接。请使用类似 https://alive.bar/@meomo 的格式。';
    state.loading = false;
    render();
    return;
  }

  try {
    // 1. Lookup Account ID
    const lookupUrl = `https://${parsed.domain}/api/v1/accounts/lookup?acct=${parsed.username}`;
    const lookupRes = await fetch(lookupUrl);
    
    if (!lookupRes.ok) {
      throw new Error('无法找到该用户，请检查链接是否正确。');
    }
    
    const accountData = await lookupRes.json();
    state.currentAccount = accountData;
    loadHistory(accountData.id);
    
    // Fetch custom emojis for this instance
    await fetchCustomEmojis(parsed.domain);
    
    render();

    // 2. Recursive Fetching
    let collectedStatuses = [];
    let nextMaxId = null;
    let isFirstBatch = true;
    let keepFetching = true;

    while (keepFetching) {
      // Construct URL
      let statusesUrl = `https://${parsed.domain}/api/v1/accounts/${accountData.id}/statuses?exclude_replies=true&exclude_reblogs=true`;
      
      // Use limit=40 consistent with API defaults
      statusesUrl += `&limit=40`;

      if (nextMaxId) {
        statusesUrl += `&max_id=${nextMaxId}`;
      }

      const res = await fetch(statusesUrl);
      if (!res.ok) throw new Error('Fetching interrupted.');

      const batch = await res.json();

      if (batch.length === 0) {
        keepFetching = false;
      } else {
        collectedStatuses = [...collectedStatuses, ...batch];
        state.allStatuses = [...collectedStatuses];
        state.fetchCount = collectedStatuses.length;
        updateFetchCount(); // Only update the count, don't re-render entire card
        
        nextMaxId = batch[batch.length - 1].id;
        isFirstBatch = false;

        // Rate limit protection: wait 300ms
        await new Promise(r => setTimeout(r, 300));
      }
    }
    
    if (collectedStatuses.length === 0) {
      throw new Error('该用户没有公开的原创嘟文。');
    }

    // Try to save full dataset to local storage
    try {
      localStorage.setItem(`cached_data_${accountData.id}`, JSON.stringify(collectedStatuses));
    } catch (e) {
      console.warn('Storage quota exceeded, could not cache full dataset.');
    }
    
  } catch (err) {
    state.error = err.message || '发生未知错误';
  } finally {
    state.loading = false;
    render();
  }
};

// Handle File Import
const handleFileUpload = (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  state.loading = true;
  state.error = null;
  state.currentStatus = null;
  state.currentAccount = null;
  state.allStatuses = [];
  render();

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const jsonContent = JSON.parse(event.target?.result);
      
      // Detect Backup format vs Raw Array format
      let statuses = [];
      let account = null;
      let restoredIds = null;

      if (Array.isArray(jsonContent)) {
          // Raw Array Format
          if (jsonContent.length === 0 || !jsonContent[0].id || !jsonContent[0].account) {
              throw new Error('无效的 JSON 数据格式。');
          }
          statuses = jsonContent;
          account = statuses[0].account;
      } else if (jsonContent.type === 'mastodon-picker-backup' && Array.isArray(jsonContent.statuses)) {
          // Backup with Progress Format
          statuses = jsonContent.statuses;
          account = jsonContent.account;
          restoredIds = new Set(jsonContent.viewedIds);
      } else {
          throw new Error('无法识别的文件格式。');
      }

      if (!account) throw new Error('无法从文件中解析用户信息。');

      state.currentAccount = account;
      state.allStatuses = statuses;
      
      if (restoredIds) {
          state.viewedIds = restoredIds;
          saveHistory(account.id, restoredIds);
      } else {
          loadHistory(account.id);
      }
      
      // Fetch custom emojis for this instance
      const domain = extractDomainFromAccount(account);
      if (domain) {
        await fetchCustomEmojis(domain);
      }
      
    } catch (err) {
      state.error = err.message || '解析文件失败';
    } finally {
      state.loading = false;
      render();
    }
  };
  reader.readAsText(file);
};

// Handle Random Pick
const pickRandomStatus = () => {
  if (!state.currentAccount || state.allStatuses.length === 0) return;

  // Filter out already seen IDs
  const availableStatuses = state.allStatuses.filter(s => !state.viewedIds.has(s.id));

  if (availableStatuses.length === 0) {
    if (window.confirm('您已经看完了列表中的所有嘟文。是否重置记录并重新开始？')) {
      clearHistory();
    }
    return;
  }

  const randomIndex = Math.floor(Math.random() * availableStatuses.length);
  const selected = availableStatuses[randomIndex];

  state.currentStatus = selected;
  
  const newViewedIds = new Set(state.viewedIds);
  newViewedIds.add(selected.id);
  state.viewedIds = newViewedIds;
  saveHistory(state.currentAccount.id, newViewedIds);
  render();
};

// Clear History
const clearHistory = () => {
  if (!state.currentAccount) return;
  saveHistory(state.currentAccount.id, new Set());
  state.viewedIds = new Set();
  state.currentStatus = null;
  render();
};

// Return to Home
const returnToHome = () => {
  state.currentAccount = null;
  state.allStatuses = [];
  state.currentStatus = null;
  state.viewedIds = new Set();
  state.error = null;
  state.loading = false;
  state.fetchCount = 0;
  fullscreenImageUrl = null;
  render();
};

// Auto-load cached data on page load
const autoLoadCachedData = async () => {
  // Find all cached data keys
  const cachedKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('cached_data_')) {
      cachedKeys.push(key);
    }
  }

  if (cachedKeys.length === 0) {
    return; // No cached data
  }

  // Try to load the most recent cache (or first one if multiple)
  // For simplicity, we'll use the first one found
  // In a more sophisticated version, we could track which was last used
  const cacheKey = cachedKeys[0];
  const accountId = cacheKey.replace('cached_data_', '');
  
  try {
    const cachedStatuses = JSON.parse(localStorage.getItem(cacheKey));
    if (cachedStatuses && Array.isArray(cachedStatuses) && cachedStatuses.length > 0) {
      // Get account from first status
      const account = cachedStatuses[0].account;
      if (account) {
        state.currentAccount = account;
        state.allStatuses = cachedStatuses;
        loadHistory(account.id);
        
        // Fetch custom emojis for this instance
        const domain = extractDomainFromAccount(account);
        if (domain) {
          await fetchCustomEmojis(domain);
        }
        
        render();
      }
    }
  } catch (e) {
    console.warn('Failed to load cached data:', e);
  }
};

// Download Raw Data
const handleDownloadRaw = () => {
  if (state.currentAccount && state.allStatuses.length > 0) {
    downloadJson(state.allStatuses, `mastodon_data_${state.currentAccount.username}.json`);
  }
};

// Download Data with Progress
const handleDownloadBackup = () => {
  if (state.currentAccount && state.allStatuses.length > 0) {
    const backup = {
      type: 'mastodon-picker-backup',
      timestamp: new Date().toISOString(),
      account: state.currentAccount,
      statuses: state.allStatuses,
      viewedIds: Array.from(state.viewedIds),
    };
    downloadJson(backup, `mastodon_backup_${state.currentAccount.username}_${new Date().toISOString().slice(0, 10)}.json`);
  }
};

// Global state for fullscreen image
let fullscreenImageUrl = null;

// StatusCard Component
const renderStatusCard = (status) => {
  const { account, content, created_at, media_attachments, favourites_count, reblogs_count, replies_count, url } = status;
  
  const cardHtml = `
    <div class="bg-white rounded-xl shadow-lg border border-slate-100 overflow-hidden w-full max-w-2xl mx-auto transition-all duration-300 hover:shadow-xl">
      <div class="p-6">
        <!-- Header: Avatar and Name -->
        <div class="flex items-center mb-4">
          <img 
            src="${account.avatar}" 
            alt="${account.display_name}" 
            class="w-12 h-12 rounded-full border border-slate-200 mr-3 object-cover"
          />
          <div class="flex-1 min-w-0">
            <h3 class="text-lg font-bold text-slate-900 truncate flex items-center gap-1">
              ${replaceCustomEmojis(account.display_name || account.username)}
            </h3>
            <p class="text-sm text-slate-500 truncate">@${account.acct}</p>
          </div>
          <a 
            href="${url}" 
            target="_blank" 
            rel="noopener noreferrer"
            class="text-slate-400 hover:text-indigo-600 transition-colors"
            title="Open in Mastodon"
          >
            ${icons.ExternalLink(20)}
          </a>
        </div>

        <!-- Content -->
        <div class="prose prose-slate prose-p:my-2 prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline text-slate-800 break-words text-base leading-relaxed">
          ${replaceCustomEmojis(content)}
        </div>

        <!-- Media Attachments -->
        ${media_attachments.length > 0 ? `
          <div class="grid gap-2 mt-4 ${media_attachments.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}">
            ${media_attachments.map((media, idx) => `
              <div class="relative group overflow-hidden rounded-lg bg-slate-100">
                ${media.type === 'image' ? `
                  <img 
                    src="${media.url}" 
                    alt="${(media.description || 'Attached media').replace(/"/g, '&quot;')}" 
                    class="w-full h-auto max-h-96 object-cover cursor-zoom-in hover:scale-105 transition-transform duration-500 media-image"
                    loading="lazy"
                    data-image-url="${media.url.replace(/"/g, '&quot;')}"
                  />
                ` : media.type === 'video' || media.type === 'gifv' ? `
                  <video 
                    src="${media.url}" 
                    controls 
                    class="w-full h-auto max-h-96"
                  ></video>
                ` : `
                  <div class="p-4 text-center text-slate-500">
                    Unsupported media type: ${media.type}
                  </div>
                `}
              </div>
            `).join('')}
          </div>
        ` : ''}

        <!-- Metadata & Stats -->
        <div class="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between text-slate-500 text-sm">
          <span class="font-medium">${formatDate(created_at)}</span>
          
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-1 hover:text-blue-600 transition-colors">
              ${icons.MessageCircle(18)}
              <span>${replies_count}</span>
            </div>
            <div class="flex items-center gap-1 hover:text-green-600 transition-colors">
              ${icons.Repeat(18)}
              <span>${reblogs_count}</span>
            </div>
            <div class="flex items-center gap-1 hover:text-pink-600 transition-colors">
              ${icons.Heart(18)}
              <span>${favourites_count}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  return cardHtml;
};

// Update fetch count only (for performance during fetching)
const updateFetchCount = () => {
  const countElement = document.getElementById('fetch-count');
  if (countElement) {
    countElement.textContent = state.fetchCount;
  }
};

// Main render function
const render = () => {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="min-h-screen flex flex-col items-center py-10 px-4 bg-slate-50">
      
      <!-- Header -->
      <header class="mb-10 text-center">
        <h1 class="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-purple-600 mb-2">
          毛象乱选
        </h1>
        <p class="text-slate-500 font-medium leading-relaxed">
          Mastodon Random Picker
          <br />
          <span class="text-sm">
            Made by <a href="https://mo.b-hu.org" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline">梦貘</a> with ❤️
          </span>
        </p>
      </header>

      <!-- Input Section (Hidden when data is loaded) -->
      ${!state.currentAccount ? `
        <div class="w-full max-w-xl mb-8 animate-fade-in">
          ${state.mode === 'url' ? `
            <form id="url-form" class="relative flex items-center shadow-lg rounded-full bg-white border border-slate-200 focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-transparent transition-all overflow-hidden z-10">
              <input
                type="url"
                id="url-input"
                class="w-full py-4 pl-6 pr-14 outline-none text-slate-700 placeholder:text-slate-400"
                placeholder="输入 Mastodon 主页链接 (如 https://alive.bar/@meomo)"
                value="${state.urlInput}"
                required
                ${state.loading ? 'disabled' : ''}
              />
              <button
                type="submit"
                class="absolute right-2 top-1/2 -translate-y-1/2 bg-indigo-600 hover:bg-indigo-700 text-white p-2.5 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                ${state.loading ? 'disabled' : ''}
              >
                ${state.loading ? icons.Loader2(20) : icons.Search(20)}
              </button>
            </form>
          ` : `
            <div class="relative flex items-center justify-center p-8 border-2 border-dashed border-slate-300 rounded-2xl bg-white hover:bg-slate-50 transition-colors cursor-pointer" id="file-drop-zone">
              <input 
                type="file" 
                id="file-input"
                class="hidden" 
                accept=".json"
              />
              <div class="flex flex-col items-center text-slate-500">
                <div class="mb-2 text-indigo-500">${icons.Upload(32)}</div>
                <p class="font-medium">点击导入 JSON 文件</p>
                <p class="text-xs text-slate-400 mt-1">支持原始数据或含进度的备份文件</p>
              </div>
            </div>
          `}

          <!-- Toggle Mode -->
          ${!state.loading ? `
            <div class="text-center mt-3">
              <button 
                id="toggle-mode"
                class="text-xs text-slate-400 hover:text-indigo-600 underline decoration-dotted transition-colors"
              >
                ${state.mode === 'url' ? '已有数据？导入本地 JSON 文件' : '返回链接抓取模式'}
              </button>
            </div>
          ` : ''}

          <!-- Loading Progress (Before account info is loaded) -->
          ${state.loading && state.mode === 'url' && !state.currentAccount ? `
            <div class="mt-4 text-center text-indigo-600 font-medium animate-pulse flex items-center justify-center gap-2">
              ${icons.Loader2(16)}
              <span>正在查找用户信息...</span>
            </div>
          ` : ''}
          ${state.loading && state.mode === 'url' && state.currentAccount && state.fetchCount === 0 ? `
            <div class="mt-4 text-center text-indigo-600 font-medium animate-pulse flex items-center justify-center gap-2">
              ${icons.Loader2(16)}
              <span>开始抓取数据...</span>
            </div>
          ` : ''}

          ${state.error ? `
            <div class="mt-4 p-3 bg-red-50 text-red-600 rounded-lg flex items-start gap-2 text-sm border border-red-100">
              ${icons.AlertCircle(18)}
              <span>${state.error}</span>
            </div>
          ` : ''}

          <!-- Tutorial Section -->
          <div class="mt-8 border border-slate-100 rounded-xl bg-white overflow-hidden shadow-sm">
            <button 
              id="toggle-tutorial"
              class="w-full flex items-center justify-between p-4 text-slate-600 hover:bg-slate-50 transition-colors font-medium text-sm"
            >
              <div class="flex items-center gap-2">
                ${icons.Info(18)}
                <span>如何使用？(点击展开)</span>
              </div>
              ${state.showTutorial ? icons.ChevronUp(16) : icons.ChevronDown(16)}
            </button>
            
            ${state.showTutorial ? `
              <div class="p-4 pt-0 text-slate-500 text-sm leading-relaxed border-t border-slate-50 bg-slate-50/50">
                <ul class="list-disc list-inside space-y-2 mt-2">
                  <li><strong>获取链接</strong>：请打开您的长毛象主页（例如点击头像进入个人主页），然后从浏览器地址栏复制完整的链接（如 <code>https://alive.bar/@meomo</code>）。</li>
                  <li><strong>粘贴链接</strong>：将复制的链接粘贴到上方的输入框中，点击搜索按钮开始抓取。</li>
                  <li><strong>抓取限制</strong>：由于 API 限制，程序每次请求约 40 条嘟文。如果您的嘟文数量较多，程序会自动多次请求，请耐心等待。</li>
                  <li><strong>减轻服务器压力</strong>：强烈建议您在抓取完成后，点击"下载数据"保存到本地。下次想看时，直接使用"导入本地 JSON 文件"功能，既快又不会给服务器造成负担。</li>
                  <li><strong>网络环境</strong>：本工具为纯本地运行（Static Web App）。能否成功抓取数据和显示图片，完全取决于您的网络环境能否顺畅访问该长毛象实例。</li>
                  <li><strong>含进度备份</strong>：浏览一部分后，可以使用"下载数据 + 进度"保存当前状态，下次导入可继续从上次的位置开始随机浏览。</li>
                  <li><strong>自动加载缓存</strong>：如果您之前抓取过数据，刷新页面后程序会自动加载本地缓存的数据，无需重新抓取。只要您不清除浏览器缓存，就可以随时访问查看。</li>
                </ul>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Loading State (When fetching data) -->
      ${state.currentAccount && state.loading ? `
        <div class="w-full max-w-2xl flex flex-col items-center gap-8 animate-fade-in-up">
          <div class="w-full min-h-[200px] flex justify-center items-start">
            <div class="text-center text-slate-400 mt-4 w-full">
              <div class="bg-white p-8 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center">
                <div class="relative mb-4">
                  <img 
                    src="${state.currentAccount.avatar}" 
                    alt="${state.currentAccount.display_name}" 
                    class="w-20 h-20 rounded-full border-4 border-slate-50"
                  />
                  <div class="absolute -bottom-1 -right-1 bg-indigo-500 text-white p-1 rounded-full border-2 border-white">
                    ${icons.Loader2(14)}
                  </div>
                </div>
                <h2 class="text-xl font-bold text-slate-800">${replaceCustomEmojis(state.currentAccount.display_name || state.currentAccount.username)}</h2>
                <p class="text-sm text-slate-500 mb-6">@${state.currentAccount.acct}</p>
                
                <div class="bg-indigo-50 px-6 py-4 rounded-lg text-sm text-indigo-700 mb-2 flex items-center gap-2">
                  ${icons.Loader2(20)}
                  <div class="text-left">
                    <p class="font-bold">正在抓取数据...</p>
                    <p>已抓取 <span id="fetch-count" class="font-bold text-indigo-600">${state.fetchCount}</span> 条嘟文，请耐心等待</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Main Content Area (Data Loaded) -->
      ${state.currentAccount && state.allStatuses.length > 0 && !state.loading ? `
        <div class="w-full max-w-2xl flex flex-col items-center gap-8 animate-fade-in-up">
          
          <!-- 1. Status Display -->
          <div class="w-full min-h-[200px] flex justify-center items-start" id="status-display">
            ${state.currentStatus ? renderStatusCard(state.currentStatus) : ''}
            ${!state.currentStatus ? `
              <div class="text-center text-slate-400 mt-4 w-full">
                <div class="bg-white p-8 rounded-2xl shadow-sm border border-slate-100 flex flex-col items-center">
                  <div class="relative mb-4">
                     <img 
                        src="${state.currentAccount.avatar}" 
                        alt="${state.currentAccount.display_name}" 
                        class="w-20 h-20 rounded-full border-4 border-slate-50"
                      />
                      <div class="absolute -bottom-1 -right-1 bg-green-500 text-white p-1 rounded-full border-2 border-white">
                        ${icons.FileJson(14)}
                      </div>
                  </div>
                  <h2 class="text-xl font-bold text-slate-800">${replaceCustomEmojis(state.currentAccount.display_name || state.currentAccount.username)}</h2>
                  <p class="text-sm text-slate-500 mb-6">@${state.currentAccount.acct}</p>
                  
                  <div class="bg-slate-50 px-4 py-3 rounded-lg text-sm text-slate-500 mb-2">
                    <p>已就绪数据: <span class="font-bold text-indigo-600">${state.allStatuses.length}</span> 条</p>
                    <p>剩余未读: <span class="font-bold text-indigo-600">${state.allStatuses.length - state.viewedIds.size}</span> 条</p>
                  </div>
                </div>
              </div>
            ` : ''}
          </div>

          <!-- 2. Controls - Below Status -->
          <div class="flex flex-col gap-3 items-center w-full pb-10">
            <!-- Primary Action -->
            <button
              id="pick-random"
              class="group w-full max-w-xs flex justify-center items-center gap-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white px-8 py-4 rounded-xl font-bold shadow-lg shadow-indigo-200 transition-all hover:-translate-y-0.5 active:translate-y-0 text-lg"
            >
              <span class="group-hover:rotate-180 transition-transform duration-500">${icons.Shuffle(20)}</span>
              <span>${state.currentStatus ? '再来一条' : '开始随机抽取'}</span>
            </button>

            <!-- Secondary Actions: Downloads -->
            <div class="flex gap-2 w-full max-w-xs">
              <button
                id="download-raw"
                class="flex-1 flex justify-center items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                title="只下载嘟文数据"
              >
                ${icons.Download(16)}
                <span>下载数据</span>
              </button>
              
              <button
                id="download-backup"
                class="flex-1 flex justify-center items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-indigo-600 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                title="下载嘟文数据和已读进度"
              >
                ${icons.Save(16)}
                <span>数据 + 进度</span>
              </button>
            </div>

            <!-- Tertiary Actions: Reset and Return Home -->
            <div class="flex flex-col gap-2 items-center mt-2">
              ${state.viewedIds.size > 0 ? `
                <button
                  id="clear-history"
                  class="flex items-center gap-2 text-slate-400 hover:text-red-500 px-4 py-2 rounded-lg text-xs transition-colors"
                  title="清除该用户的已读记录"
                >
                  ${icons.Trash2(14)}
                  <span>重置已读记录 (${state.viewedIds.size})</span>
                </button>
              ` : ''}
              <button
                id="return-home"
                class="flex items-center gap-2 text-slate-400 hover:text-indigo-600 px-4 py-2 rounded-lg text-xs transition-colors"
                title="回到首页重新抓取/导入"
              >
                ${icons.Home(14)}
                <span>回到首页</span>
              </button>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Footer -->
      <footer class="mt-auto py-6 text-slate-400 text-xs text-center">
        <p>© ${new Date().getFullYear()} 毛象乱选 - Powered by Mastodon API</p>
      </footer>
      
      ${fullscreenImageUrl ? `
        <div 
          id="fullscreen-overlay"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm animate-fade-in cursor-zoom-out"
        >
          <button 
            id="close-fullscreen"
            class="absolute top-4 right-4 text-white/70 hover:text-white transition-colors p-2 bg-black/20 rounded-full"
          >
            ${icons.X(32)}
          </button>
          <img 
            src="${fullscreenImageUrl}" 
            alt="Fullscreen view" 
            class="max-w-full max-h-[90vh] object-contain rounded-md shadow-2xl"
          />
        </div>
      ` : ''}
    </div>
  `;

  // Attach event listeners
  attachEventListeners();
};

// Attach event listeners
const attachEventListeners = () => {
  // URL form
  const urlForm = document.getElementById('url-form');
  if (urlForm) {
    urlForm.addEventListener('submit', handleFetch);
  }

  // URL input
  const urlInput = document.getElementById('url-input');
  if (urlInput) {
    urlInput.addEventListener('input', (e) => {
      state.urlInput = e.target.value;
    });
  }

  // File input
  const fileInput = document.getElementById('file-input');
  const fileDropZone = document.getElementById('file-drop-zone');
  if (fileInput && fileDropZone) {
    fileDropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileUpload);
  }

  // Toggle mode
  const toggleMode = document.getElementById('toggle-mode');
  if (toggleMode) {
    toggleMode.addEventListener('click', () => {
      state.mode = state.mode === 'url' ? 'file' : 'url';
      render();
    });
  }

  // Toggle tutorial
  const toggleTutorial = document.getElementById('toggle-tutorial');
  if (toggleTutorial) {
    toggleTutorial.addEventListener('click', () => {
      state.showTutorial = !state.showTutorial;
      render();
    });
  }

  // Pick random
  const pickRandom = document.getElementById('pick-random');
  if (pickRandom) {
    pickRandom.addEventListener('click', pickRandomStatus);
  }

  // Download raw
  const downloadRaw = document.getElementById('download-raw');
  if (downloadRaw) {
    downloadRaw.addEventListener('click', handleDownloadRaw);
  }

  // Download backup
  const downloadBackup = document.getElementById('download-backup');
  if (downloadBackup) {
    downloadBackup.addEventListener('click', handleDownloadBackup);
  }

  // Clear history
  const clearHistoryBtn = document.getElementById('clear-history');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', clearHistory);
  }

  // Return to home
  const returnHomeBtn = document.getElementById('return-home');
  if (returnHomeBtn) {
    returnHomeBtn.addEventListener('click', returnToHome);
  }

  // Media image click handlers
  const mediaImages = document.querySelectorAll('.media-image');
  mediaImages.forEach(img => {
    img.addEventListener('click', (e) => {
      fullscreenImageUrl = e.target.getAttribute('data-image-url');
      render();
    });
  });

  // Fullscreen overlay
  const fullscreenOverlay = document.getElementById('fullscreen-overlay');
  const closeFullscreenBtn = document.getElementById('close-fullscreen');
  if (fullscreenOverlay) {
    fullscreenOverlay.addEventListener('click', (e) => {
      if (e.target === fullscreenOverlay || e.target === closeFullscreenBtn || e.target.closest('#close-fullscreen')) {
        fullscreenImageUrl = null;
        render();
      }
    });
  }
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Try to auto-load cached data first
  autoLoadCachedData();
  // If no cached data was loaded, render empty state
  if (!state.currentAccount) {
    render();
  }
});

