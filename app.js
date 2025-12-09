import { parseMastodonUrl, formatDate, downloadJson } from './utils.js';
import { icons } from './icons.js';

// Global keyboard handler for fullscreen images
let keyboardHandler = null;
const setupKeyboardNavigation = () => {
  // Remove old handler if exists
  if (keyboardHandler) {
    window.removeEventListener('keydown', keyboardHandler);
  }
  
  // Add new handler
  keyboardHandler = (e) => {
    if (fullscreenImageState.currentIndex === null) return;
    if (e.key === 'ArrowLeft' && fullscreenImageState.currentIndex > 0) {
      fullscreenImageState.currentIndex--;
      render();
    } else if (e.key === 'ArrowRight' && fullscreenImageState.currentIndex < fullscreenImageState.images.length - 1) {
      fullscreenImageState.currentIndex++;
      render();
    } else if (e.key === 'Escape') {
      fullscreenImageState = { currentIndex: null, images: [] };
      render();
    }
  };
  window.addEventListener('keydown', keyboardHandler);
};

// State management
let state = {
  mode: 'url',
  urlInput: '',
  showTutorial: false,
  loading: false,
  fetchType: null, // 'initial' | 'older' | 'newer' | null
  fetchCount: 0,
  error: null,
  currentAccount: null,
  allStatuses: [],
  currentStatus: null,
  viewedIds: new Set(),
  customEmojis: [], // Store custom emojis for current instance
  // 抓取配置 (Fetch Settings)
  fetchConfig: {
    excludeReplies: true,
    excludeReblogs: true,
    mode: 'all', // 'all' | 'limit_count' | 'limit_date'
    limitCount: 100,
    limitDate: new Date().toISOString().slice(0, 10),
  },
  // 显示筛选 (Display Filters - 抓取后生效)
  displayFilter: {
    startDate: '',
    endDate: '',
    showReplies: true,
    showReblogs: true,
  },
  showFilters: false, // 是否展开筛选面板
  // 暂停控制
  isPaused: false,
};

// 使用Ref在循环中即时读取（纯JS中用变量代替）
let pausedRef = false;
let stopRef = false;

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

// 切换暂停状态
const togglePause = () => {
  const nextState = !state.isPaused;
  state.isPaused = nextState;
  pausedRef = nextState;
  render();
};

// 停止抓取
const stopFetch = () => {
  stopRef = true;
  // 如果处于暂停状态，需要先恢复以便跳出循环
  if (pausedRef) {
    pausedRef = false;
    state.isPaused = false;
  }
  render();
};

// -------------------------------------------------------------------------
// 核心功能：统一抓取逻辑 (Handle Fetch)
// 支持：初始化抓取、抓取更多(older)、抓取更新(newer)
// -------------------------------------------------------------------------
const executeFetch = async (type) => {
  state.error = null;
  state.loading = true;
  state.fetchType = type;
  state.fetchCount = 0;
  
  // 重置控制标志
  stopRef = false;
  pausedRef = false;
  state.isPaused = false;

  // 如果是初始抓取，清空旧数据
  if (type === 'initial') {
    state.allStatuses = [];
    state.currentStatus = null;
    state.currentAccount = null;
  }

  // 解析 URL 或使用当前 Account
  let domain = '';
  let accountId = '';
  let accountData = state.currentAccount;

  try {
    if (type === 'initial') {
      const parsed = parseMastodonUrl(state.urlInput);
      if (!parsed) {
        throw new Error('无效的 Mastodon 用户链接。');
      }
      domain = parsed.domain;
      
      // 1. 获取账户信息
      const lookupUrl = `https://${parsed.domain}/api/v1/accounts/lookup?acct=${parsed.username}`;
      const lookupRes = await fetch(lookupUrl);
      if (!lookupRes.ok) throw new Error('无法找到该用户。');
      
      accountData = await lookupRes.json();
      if (!accountData) throw new Error('账户数据解析失败');

      state.currentAccount = accountData;
      loadHistory(accountData.id);
      accountId = accountData.id;
      
      // Fetch custom emojis for this instance
      await fetchCustomEmojis(domain);
      
      render();
    } else {
      // 如果是继续抓取或更新，必须已有账户信息
      if (!state.currentAccount) throw new Error('未找到账户信息');
      try {
        const u = new URL(state.currentAccount.url);
        domain = u.hostname;
      } catch {
        const p = parseMastodonUrl(state.urlInput);
        if (p) domain = p.domain;
        else throw new Error('无法解析实例域名');
      }
      accountId = state.currentAccount.id;
      accountData = state.currentAccount;
    }

    // 2. 准备循环抓取
    // 对于 'older' (继续抓取): max_id = 当前列表中最后一条的ID
    // 对于 'newer' (抓取更新): since_id = 当前列表中第一条的ID
    // 对于 'initial': 不传 max_id/since_id
    
    let nextMaxId = null;
    let sinceId = null;

    if (type === 'older' && state.allStatuses.length > 0) {
      nextMaxId = state.allStatuses[state.allStatuses.length - 1].id;
    }
    if (type === 'newer' && state.allStatuses.length > 0) {
      sinceId = state.allStatuses[0].id;
    }

    let keepFetching = true;
    let sessionCollectedCount = 0; // 本次操作抓取的数量

    while (keepFetching) {
      // 检查停止信号
      if (stopRef) {
        break;
      }

      // 检查暂停信号
      if (pausedRef) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue; // 跳过本次循环，重新检查
      }

      // 构造 API URL
      // 基础参数
      let statusesUrl = `https://${domain}/api/v1/accounts/${accountId}/statuses?limit=40`;
      
      // 应用抓取前的筛选配置 (只在 initial 模式或 older 模式下应用较好，newer 模式通常希望获取所有更新)
      // 但为了统一，我们始终应用用户的配置
      if (state.fetchConfig.excludeReplies) statusesUrl += `&exclude_replies=true`;
      if (state.fetchConfig.excludeReblogs) statusesUrl += `&exclude_reblogs=true`;

      // 分页参数
      if (nextMaxId) statusesUrl += `&max_id=${nextMaxId}`;
      if (sinceId) statusesUrl += `&since_id=${sinceId}`; // 注意: Mastodon API 对于 since_id 有时只返回新数据，不一定分页

      // 发起请求
      const res = await fetch(statusesUrl);
      if (!res.ok) throw new Error('API 请求失败: ' + res.statusText);
      
      const batch = await res.json();

      // 停止条件1: 空数组
      if (batch.length === 0) {
        keepFetching = false;
        break;
      }

      // 处理数据
      // 如果是 'newer' 模式，Mastodon 返回的是从 since_id 之后的所有数据（可能很多），或者按 limit 分页
      // 如果是分页的，新数据是倒序的（最新的在最前）。
      // 我们需要把 batch 加到 allStatuses 的前面 (如果是 newer) 或后面 (older/initial)

      let filteredBatch = batch;

      // 停止条件2: 按日期筛选 (抓取某年某月某日之后的帖子)
      // 解析 created_at 判断
      if (state.fetchConfig.mode === 'limit_date' && type !== 'newer') { // newer 模式不应受旧日期限制
        const limitTime = new Date(state.fetchConfig.limitDate).getTime();
        // 检查 batch 中最后一条是否已经早于 limitDate
        const lastItemTime = new Date(batch[batch.length - 1].created_at).getTime();
        
        if (lastItemTime < limitTime) {
          // 这一批里有部分数据过期了，截断
          filteredBatch = batch.filter(s => new Date(s.created_at).getTime() >= limitTime);
          keepFetching = false; // 到了截止日期，停止
        }
      }

      // 更新状态 (UI显示)
      if (filteredBatch.length > 0) {
        if (type === 'newer') {
          // 对于更新，我们要加到最前面
          // 注意：如果 batch 有多页，这里逻辑稍微复杂。通常 since_id 抓取用于少量更新。
          // 简单起见，我们假设 newer 抓取是一次性的或者 batch 是最新的。
          // 实际上 API 可能会返回 [新3, 新2, 新1]。我们直接解构。
          state.allStatuses = [...filteredBatch, ...state.allStatuses];
        } else {
          state.allStatuses = [...state.allStatuses, ...filteredBatch];
        }
        sessionCollectedCount += filteredBatch.length;
        state.fetchCount = sessionCollectedCount;
        
        // 更新UI（增量更新）
        if (type === 'initial' || (type === 'older' && !state.currentAccount)) {
          // 初始抓取时，需要完整渲染
          render();
        } else {
          // 增量抓取时，只更新计数
          updateFetchCount();
        }
      }

      // 停止条件3: 按数量筛选 (抓取最新的 N 条)
      if (state.fetchConfig.mode === 'limit_count' && type === 'initial') {
        if (sessionCollectedCount >= state.fetchConfig.limitCount) {
          // 如果超出了，可能需要截断 (这里简单处理，不截断多余的几条，直接停)
          keepFetching = false;
        }
      }

      // 准备下一页
      if (keepFetching) {
        if (type === 'newer') {
          // 抓取更新时，通常 since_id 机制不同。
          // 如果返回了满 limit 条，说明可能还有更新的。
          // 这里的 min_id/since_id 分页逻辑比较复杂，简单实现：只抓一页更新，或者
          // 更新 `sinceId` 为 batch[0].id (最新的ID) ? 不，since_id 是基准。
          // 如果 batch.length < 40，说明没更多了。
          if (batch.length < 40) keepFetching = false;
          else {
            // 如果还有更多更新的（较少见），Mastodon API 文档建议用 min_id 向上翻页
            // 这里简化：抓取更新暂时只抓取第一页 (40条)
            keepFetching = false; 
          }
        } else {
          // Initial 或 Older，向下翻页
          nextMaxId = batch[batch.length - 1].id;
          // 避免 API 速率限制
          await new Promise(r => setTimeout(r, 400));
        }
      }
    } // end while

    if (type === 'initial' && sessionCollectedCount === 0) {
      // 如果不是被停止的，才报错
      if (!stopRef) {
        throw new Error('未获取到符合条件的嘟文。');
      }
    }

    // 缓存数据
    if (accountData && type === 'initial') {
      try {
        localStorage.setItem(`cached_data_${accountData.id}`, JSON.stringify(state.allStatuses));
      } catch (e) {
        console.warn('Storage quota exceeded, could not cache full dataset.');
      }
    }

  } catch (err) {
    state.error = err.message || '发生未知错误';
  } finally {
    state.loading = false;
    state.fetchType = null;
    stopRef = false;
    state.isPaused = false;
    render();
  }
};

// Handle URL Fetch (兼容旧接口)
const handleFetch = async (e) => {
  e.preventDefault();
  await executeFetch('initial');
};

// Parse ActivityPub actor.json to Mastodon API account format
const parseActivityPubActor = (actorData) => {
  if (!actorData || actorData.type !== 'Person') {
    return null;
  }

  try {
    const actorUrl = typeof actorData.id === 'string' ? actorData.id : actorData.id?.id || actorData.id;
    const url = new URL(actorUrl);
    const pathParts = url.pathname.split('/').filter(p => p);
    const username = pathParts[pathParts.length - 1] || actorData.preferredUsername || 'unknown';
    const domain = url.hostname;

    // 处理头像URL（可能是相对路径）
    let avatarUrl = '';
    if (actorData.icon) {
      if (typeof actorData.icon === 'string') {
        avatarUrl = actorData.icon;
      } else if (actorData.icon.url) {
        avatarUrl = actorData.icon.url;
        // 如果是相对路径，转换为绝对路径
        if (!avatarUrl.startsWith('http')) {
          avatarUrl = `https://${domain}/${avatarUrl}`;
        }
      }
    }

    return {
      id: username, // 使用用户名作为ID
      username: username,
      acct: username,
      display_name: actorData.name || username,
      url: actorData.url || actorUrl,
      avatar: avatarUrl || `https://${domain}/avatars/original/missing.png`,
      note: actorData.summary || '',
    };
  } catch (e) {
    console.warn('解析actor.json失败:', e);
    return null;
  }
};

// Parse ActivityPub outbox.json format to Mastodon API format
const parseActivityPubOutbox = (outboxData, actorAccount = null, fileMap = null) => {
  if (!outboxData.orderedItems || !Array.isArray(outboxData.orderedItems)) {
    throw new Error('无效的 ActivityPub outbox 格式。');
  }

  const statuses = [];
  let account = actorAccount;
  let actorUrl = null;

  // 辅助函数：将媒体文件路径转换为blob URL（如果是本地文件）
  const resolveMediaUrl = (url) => {
    if (!url) return url;
    // 如果是完整的HTTP(S) URL，直接返回
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // 如果是相对路径，尝试从fileMap中查找
    if (fileMap) {
      const fileName = url.split('/').pop();
      const file = fileMap.get(fileName.toLowerCase());
      if (file) {
        return URL.createObjectURL(file);
      }
      // 也尝试在media_attachments子文件夹中查找
      const mediaFile = fileMap.get(`media_attachments/${fileName}`.toLowerCase());
      if (mediaFile) {
        return URL.createObjectURL(mediaFile);
      }
    }
    return url; // 如果找不到，返回原路径
  };

  for (const activity of outboxData.orderedItems) {
    if (activity.type === 'Create' && activity.object && activity.object.type === 'Note') {
      // 原创嘟文
      const note = activity.object;
      
      // 提取账户信息（从第一个Create活动，如果还没有从actor.json获取）
      if (!account && note.attributedTo) {
        actorUrl = typeof note.attributedTo === 'string' ? note.attributedTo : note.attributedTo.id || note.attributedTo;
        // 从URL提取用户名和域名，例如: https://alive.bar/users/meomo
        try {
          const url = new URL(actorUrl);
          const pathParts = url.pathname.split('/').filter(p => p);
          const username = pathParts[pathParts.length - 1];
          const domain = url.hostname;
          
          account = {
            id: username, // 使用用户名作为ID（因为没有其他ID可用）
            username: username,
            acct: username,
            display_name: username,
            url: actorUrl,
            avatar: `https://${domain}/avatars/original/missing.png`, // 默认头像
          };
        } catch (e) {
          console.warn('无法解析账户URL:', actorUrl);
        }
      }

      // 转换媒体附件
      const mediaAttachments = (note.attachment || []).map(att => {
        let mediaUrl = null;
        let mediaType = 'image';
        
        if (typeof att === 'string') {
          // 如果attachment是URL字符串
          mediaUrl = att;
        } else {
          // 如果attachment是对象
          mediaUrl = att.url || att.href;
          if (att.mediaType) {
            mediaType = att.mediaType.startsWith('image/') ? 'image' : 
                       (att.mediaType.startsWith('video/') ? 'video' : 'unknown');
          }
        }
        
        // 解析URL（如果是本地文件，转换为blob URL）
        const resolvedUrl = resolveMediaUrl(mediaUrl);
        
        return {
          id: att.id || mediaUrl || Date.now().toString(),
          type: mediaType,
          url: resolvedUrl,
          preview_url: resolvedUrl,
          description: att.name || att.summary || null,
        };
      });

      // 构建status对象（Mastodon API格式）
      const status = {
        id: note.id ? note.id.split('/').pop() : Date.now().toString(), // 从URL提取ID
        created_at: note.published || activity.published,
        in_reply_to_id: note.inReplyTo ? (typeof note.inReplyTo === 'string' ? note.inReplyTo.split('/').pop() : null) : null,
        in_reply_to_account_id: null,
        sensitive: note.sensitive || false,
        spoiler_text: note.summary || '',
        visibility: 'public', // 默认公开
        language: null,
        uri: note.id || note.url,
        url: note.url,
        replies_count: note.replies?.first?.items?.length || 0,
        reblogs_count: 0,
        favourites_count: 0,
        edited_at: null,
        content: note.content || '',
        reblog: null,
        application: null,
        account: account || {
          id: 'unknown',
          username: 'unknown',
          acct: 'unknown',
          display_name: 'Unknown',
          url: actorUrl || '',
          avatar: '',
        },
        media_attachments: mediaAttachments,
        mentions: [],
        tags: (note.tag || []).map(tag => ({
          name: tag.name || tag.href?.split('/').pop() || '',
          url: tag.href || '',
        })),
        emojis: [],
        card: null,
        poll: null,
      };

      statuses.push(status);
    } else if (activity.type === 'Announce' && activity.object) {
      // 转发（Announce）
      // 对于转发，我们需要创建一个reblog格式的status
      // 但由于outbox中只有被转发帖子的URL，没有完整内容，我们只能创建一个占位符
      
      if (!account && activity.actor) {
        actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id || activity.actor;
        try {
          const url = new URL(actorUrl);
          const pathParts = url.pathname.split('/').filter(p => p);
          const username = pathParts[pathParts.length - 1];
          const domain = url.hostname;
          
          account = {
            id: username,
            username: username,
            acct: username,
            display_name: username,
            url: actorUrl,
            avatar: `https://${domain}/avatars/original/missing.png`,
          };
        } catch (e) {
          console.warn('无法解析账户URL:', actorUrl);
        }
      }

      // 从object URL提取被转发帖子的ID
      const rebloggedUrl = typeof activity.object === 'string' ? activity.object : activity.object.id || activity.object;
      const reblogId = rebloggedUrl.split('/').pop();

      // 创建一个转发格式的status
      const status = {
        id: activity.id ? activity.id.split('/').pop() : Date.now().toString(),
        created_at: activity.published,
        in_reply_to_id: null,
        in_reply_to_account_id: null,
        sensitive: false,
        spoiler_text: '',
        visibility: 'public',
        language: null,
        uri: activity.id || rebloggedUrl,
        url: rebloggedUrl,
        replies_count: 0,
        reblogs_count: 0,
        favourites_count: 0,
        edited_at: null,
        content: '',
        reblog: {
          // 被转发帖子的基本信息（从URL推断）
          id: reblogId,
          created_at: activity.published,
          in_reply_to_id: null,
          content: '[转发的帖子内容不可用]',
          url: rebloggedUrl,
          account: {
            // 从URL推断被转发帖子的作者
            id: 'unknown',
            username: 'unknown',
            acct: 'unknown',
            display_name: 'Unknown',
            url: rebloggedUrl.split('/statuses/')[0] || '',
            avatar: '',
          },
          media_attachments: [],
        },
        application: null,
        account: account || {
          id: 'unknown',
          username: 'unknown',
          acct: 'unknown',
          display_name: 'Unknown',
          url: actorUrl || '',
          avatar: '',
        },
        media_attachments: [],
        mentions: [],
        tags: [],
        emojis: [],
        card: null,
        poll: null,
      };

      statuses.push(status);
    }
  }

  if (!account) {
    throw new Error('无法从 outbox.json 中解析账户信息。');
  }

  return { statuses, account };
};

// Handle File Import (supports JSON file or folder containing Mastodon archive)
const handleFileUpload = async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  state.loading = true;
  state.error = null;
  state.currentStatus = null;
  state.currentAccount = null;
  state.allStatuses = [];
  render();

  try {
    // 检查是否是文件夹（有webkitRelativePath属性）还是单个文件
    // 如果第一个文件有webkitRelativePath，说明是文件夹选择
    const isFolder = files.length > 0 && files[0].webkitRelativePath;
    
    if (isFolder) {
      // 处理文件夹（Mastodon存档解压后的文件夹）
      const fileMap = new Map();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const path = file.webkitRelativePath || file.name;
        // 只存储文件名，忽略路径层级
        const fileName = path.split('/').pop();
        fileMap.set(fileName.toLowerCase(), file);
      }

      // 查找actor.json文件
      let actorFile = fileMap.get('actor.json');
      if (!actorFile) {
        // 尝试查找任何包含actor.json的文件
        for (const [name, file] of fileMap.entries()) {
          if (name.includes('actor.json')) {
            actorFile = file;
            break;
          }
        }
      }

      let actorAccount = null;
      if (actorFile) {
        try {
          const actorText = await actorFile.text();
          const actorData = JSON.parse(actorText);
          actorAccount = parseActivityPubActor(actorData);
          
          // 处理头像文件（如果存在）
          if (actorAccount && actorData.icon) {
            const iconUrl = typeof actorData.icon === 'string' ? actorData.icon : actorData.icon.url;
            if (iconUrl && !iconUrl.startsWith('http')) {
              // 相对路径，查找对应的文件
              const iconFileName = iconUrl.split('/').pop();
              const iconFile = fileMap.get(iconFileName.toLowerCase());
              if (iconFile) {
                actorAccount.avatar = URL.createObjectURL(iconFile);
              }
            }
          }
        } catch (e) {
          console.warn('解析actor.json失败:', e);
        }
      }

      // 查找outbox.json文件
      let outboxFile = fileMap.get('outbox.json');
      if (!outboxFile) {
        // 尝试查找任何包含outbox.json的文件
        for (const [name, file] of fileMap.entries()) {
          if (name.includes('outbox.json')) {
            outboxFile = file;
            break;
          }
        }
      }

      if (!outboxFile) {
        throw new Error('在文件夹中未找到 outbox.json 文件。请确保选择的是 Mastodon 导出的存档解压后的文件夹。');
      }

      const outboxText = await outboxFile.text();
      const outboxData = JSON.parse(outboxText);

      // 解析ActivityPub格式（传入actor账户信息和文件映射，用于处理媒体文件）
      const { statuses, account } = parseActivityPubOutbox(outboxData, actorAccount, fileMap);

      state.currentAccount = account;
      state.allStatuses = statuses;

      // 设置urlInput以便继续抓取时能正确解析域名
      if (account.url) {
        state.urlInput = account.url;
      }

      loadHistory(account.id);

      // Fetch custom emojis for this instance
      const domain = extractDomainFromAccount(account);
      if (domain) {
        await fetchCustomEmojis(domain);
      }
    } else {
      // 处理单个JSON文件（原有逻辑）
      const file = files[0];
      // 处理JSON文件（原有逻辑）
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const jsonContent = JSON.parse(event.target?.result);
          
          // Detect Backup format vs Raw Array format vs ActivityPub outbox
          let statuses = [];
          let account = null;
          let restoredIds = null;

          // 检查是否是ActivityPub outbox格式
          if (jsonContent.type === 'OrderedCollection' && jsonContent.orderedItems) {
            const parsed = parseActivityPubOutbox(jsonContent);
            statuses = parsed.statuses;
            account = parsed.account;
          } else if (Array.isArray(jsonContent)) {
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
          
          // 设置urlInput以便继续抓取时能正确解析域名
          if (account.url) {
            state.urlInput = account.url;
          }
          
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
      return; // 提前返回，因为reader是异步的
    }
  } catch (err) {
    state.error = err.message || '解析文件失败';
  } finally {
    state.loading = false;
    render();
  }
};

// Handle Random Pick - 增加显示筛选逻辑
const pickRandomStatus = () => {
  if (!state.currentAccount || state.allStatuses.length === 0) return;

  // 1. 应用显示筛选 (Display Filter)
  let pool = state.allStatuses;

  // 筛选：回复 (使用 in_reply_to_id 字段判断)
  if (!state.displayFilter.showReplies) {
    pool = pool.filter(s => {
      // 检查是否是回复：in_reply_to_id 不为 null
      // 注意：转发帖子的回复状态应该看 reblog.in_reply_to_id
      if (s.reblog) {
        // 如果是转发，检查被转发的帖子是否是回复
        return !s.reblog.in_reply_to_id;
      }
      return !s.in_reply_to_id;
    });
  }
  // 筛选：转嘟 (reblog 不为 null)
  if (!state.displayFilter.showReblogs) {
    pool = pool.filter(s => !s.reblog);
  }

  // 筛选：日期范围
  // 对于转发帖子，使用被转发帖子的日期；对于普通帖子，使用原帖日期
  if (state.displayFilter.startDate) {
    const start = new Date(state.displayFilter.startDate).getTime();
    pool = pool.filter(s => {
      const dateToCheck = s.reblog ? s.reblog.created_at : s.created_at;
      return new Date(dateToCheck).getTime() >= start;
    });
  }
  if (state.displayFilter.endDate) {
    // 结束日期包含当天，所以加一天或设为 23:59:59
    const end = new Date(state.displayFilter.endDate).getTime() + 86400000;
    pool = pool.filter(s => {
      const dateToCheck = s.reblog ? s.reblog.created_at : s.created_at;
      return new Date(dateToCheck).getTime() < end;
    });
  }

  // 2. 排除已读
  const availableStatuses = pool.filter(s => !state.viewedIds.has(s.id));

  if (pool.length === 0) {
    alert('当前筛选条件下没有符合的嘟文，请调整筛选时间或类型。');
    return;
  }

  if (availableStatuses.length === 0) {
    if (window.confirm('当前筛选范围内已看完全部嘟文。是否重置记录并重新开始？')) {
      clearHistory(); // 简单重置，实际可能只想重置当前范围的，这里重置所有
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
  fullscreenImageState = { currentIndex: null, images: [] };
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

// Global state for fullscreen image gallery
let fullscreenImageState = {
  currentIndex: null, // null means closed
  images: [], // Array of {url, description}
};

// StatusCard Component
const renderStatusCard = (status) => {
  // 判断是否是转发
  const isReblog = status.reblog !== null && status.reblog !== undefined;
  // 判断是否是回复
  const isReply = status.in_reply_to_id !== null && status.in_reply_to_id !== undefined;
  
  // 如果是转发，使用reblog的内容；否则使用原status的内容
  const displayStatus = isReblog ? status.reblog : status;
  const { account: displayAccount, content: displayContent, created_at: displayCreatedAt, media_attachments: displayMedia, favourites_count: displayFavourites, reblogs_count: displayReblogs, replies_count: displayReplies, url: displayUrl } = displayStatus;
  
  // 外层account（转发者）和url（转发帖子的链接）
  const { account, url, created_at, favourites_count, reblogs_count, replies_count } = status;
  
  const cardHtml = `
    <div class="bg-white rounded-xl shadow-lg border border-slate-100 overflow-hidden w-full max-w-2xl mx-auto transition-all duration-300 hover:shadow-xl">
      <div class="p-6">
        ${isReblog ? `
          <!-- Reblog Header: 转发者信息 -->
          <div class="flex items-center mb-2 text-sm text-slate-500">
            ${icons.Repeat(14)}
            <span class="ml-1">${replaceCustomEmojis(account.display_name || account.username)} 转发了</span>
          </div>
        ` : ''}
        ${isReply ? `
          <!-- Reply Indicator -->
          <div class="flex items-center mb-2 text-sm text-slate-500">
            ${icons.MessageCircle(14)}
            <span class="ml-1">回复</span>
          </div>
        ` : ''}
        
        <!-- Header: Avatar and Name (显示被转发帖子的作者，或原帖作者) -->
        <div class="flex items-center mb-4">
          <img 
            src="${displayAccount.avatar}" 
            alt="${displayAccount.display_name}" 
            class="w-12 h-12 rounded-full border border-slate-200 mr-3 object-cover"
          />
          <div class="flex-1 min-w-0">
            <h3 class="text-lg font-bold text-slate-900 truncate flex items-center gap-1">
              ${replaceCustomEmojis(displayAccount.display_name || displayAccount.username)}
            </h3>
            <p class="text-sm text-slate-500 truncate">@${displayAccount.acct}</p>
          </div>
          <a 
            href="${displayUrl || url}" 
            target="_blank" 
            rel="noopener noreferrer"
            class="text-slate-400 hover:text-indigo-600 transition-colors"
            title="Open in Mastodon"
          >
            ${icons.ExternalLink(20)}
          </a>
        </div>

        <!-- Content (显示被转发帖子的内容，或原帖内容) -->
        <div class="prose prose-slate prose-p:my-2 prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline text-slate-800 break-words text-base leading-relaxed">
          ${replaceCustomEmojis(displayContent || '')}
        </div>

        <!-- Media Attachments (显示被转发帖子的媒体，或原帖媒体) -->
        ${displayMedia && displayMedia.length > 0 ? (() => {
          const imageAttachments = displayMedia.filter(m => m.type === 'image');
          return `
          <div class="grid gap-2 mt-4 ${displayMedia.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}">
            ${displayMedia.map((media, idx) => {
              const imageIndex = media.type === 'image' ? imageAttachments.findIndex(img => img.id === media.id) : -1;
              return `
              <div class="relative group overflow-hidden rounded-lg bg-slate-100">
                ${media.type === 'image' ? `
                  <img 
                    src="${media.url}" 
                    alt="${(media.description || 'Attached media').replace(/"/g, '&quot;')}" 
                    class="w-full h-auto max-h-96 object-cover cursor-zoom-in hover:scale-105 transition-transform duration-500 media-image"
                    loading="lazy"
                    data-image-index="${imageIndex}"
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
            `;
            }).join('')}
          </div>
        `;
        })() : ''}

        <!-- Metadata & Stats -->
        <div class="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between text-slate-500 text-sm">
          <span class="font-medium">${formatDate(displayCreatedAt || created_at)}</span>
          
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-1 hover:text-blue-600 transition-colors">
              ${icons.MessageCircle(18)}
              <span>${displayReplies || replies_count || 0}</span>
            </div>
            <div class="flex items-center gap-1 hover:text-green-600 transition-colors">
              ${icons.Repeat(18)}
              <span>${displayReblogs || reblogs_count || 0}</span>
            </div>
            <div class="flex items-center gap-1 hover:text-pink-600 transition-colors">
              ${icons.Heart(18)}
              <span>${displayFavourites || favourites_count || 0}</span>
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
  const countElementIncremental = document.getElementById('fetch-count-incremental');
  if (countElementIncremental) {
    countElementIncremental.textContent = state.fetchCount;
  }
};

// Main render function
const render = () => {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="min-h-screen flex flex-col items-center py-10 px-4 bg-slate-50 relative">
      
      <!-- GitHub Corner Badge -->
      <a 
        href="https://github.com/vertotem/Mastodon-Random-Picker" 
        target="_blank" 
        rel="noopener noreferrer"
        class="fixed top-4 right-4 z-50 p-2.5 rounded-lg bg-white/80 backdrop-blur-sm border border-slate-200 shadow-sm text-slate-500 hover:text-slate-700 hover:bg-white hover:shadow-md transition-all duration-200"
        title="View on GitHub"
        aria-label="View on GitHub"
      >
        ${icons.Github(20)}
      </a>
      
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

            <!-- 抓取配置面板 (Advanced Settings) -->
            <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm text-sm mt-4">
              <h3 class="font-semibold text-slate-700 mb-3 flex items-center gap-2">
                ${icons.Filter(16)} 抓取设置
              </h3>
              
              <div class="space-y-4">
                <!-- 1. 类型过滤 -->
                <div class="flex gap-6">
                  <label class="flex items-center gap-2 cursor-pointer text-slate-600 hover:text-indigo-600">
                    <input 
                      type="checkbox" 
                      id="exclude-replies"
                      class="rounded text-indigo-600 focus:ring-indigo-500"
                      ${state.fetchConfig.excludeReplies ? 'checked' : ''}
                    />
                    排除回复
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer text-slate-600 hover:text-indigo-600">
                    <input 
                      type="checkbox" 
                      id="exclude-reblogs"
                      class="rounded text-indigo-600 focus:ring-indigo-500"
                      ${state.fetchConfig.excludeReblogs ? 'checked' : ''}
                    />
                    排除转嘟
                  </label>
                </div>

                <!-- 2. 抓取模式选择 -->
                <div class="flex flex-col gap-2">
                  <span class="text-slate-500 text-xs font-medium uppercase tracking-wider">抓取范围</span>
                  <div class="flex flex-col gap-2">
                    <label class="flex items-center gap-2 cursor-pointer">
                      <input 
                        type="radio" 
                        name="fetchMode" 
                        class="text-indigo-600 focus:ring-indigo-500"
                        value="all"
                        ${state.fetchConfig.mode === 'all' ? 'checked' : ''}
                      />
                      <span class="text-slate-700">抓取全部 (公开且原创/非回复)</span>
                    </label>
                    
                    <label class="flex items-center gap-2 cursor-pointer">
                      <input 
                        type="radio" 
                        name="fetchMode" 
                        class="text-indigo-600 focus:ring-indigo-500"
                        value="limit_count"
                        ${state.fetchConfig.mode === 'limit_count' ? 'checked' : ''}
                      />
                      <span class="text-slate-700">仅抓取最新 N 条:</span>
                      <input 
                        type="number" 
                        id="limit-count"
                        min="1"
                        class="w-20 px-2 py-1 border border-slate-300 rounded text-center text-sm focus:border-indigo-500 outline-none"
                        value="${state.fetchConfig.limitCount}"
                        ${state.fetchConfig.mode !== 'limit_count' ? 'disabled' : ''}
                      />
                    </label>

                    <label class="flex items-center gap-2 cursor-pointer">
                      <input 
                        type="radio" 
                        name="fetchMode" 
                        class="text-indigo-600 focus:ring-indigo-500"
                        value="limit_date"
                        ${state.fetchConfig.mode === 'limit_date' ? 'checked' : ''}
                      />
                      <span class="text-slate-700">仅抓取此日期之后的:</span>
                      <input 
                        type="date"
                        id="limit-date"
                        class="px-2 py-1 border border-slate-300 rounded text-sm focus:border-indigo-500 outline-none"
                        value="${state.fetchConfig.limitDate}"
                        ${state.fetchConfig.mode !== 'limit_date' ? 'disabled' : ''}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          ` : `
            <div class="relative flex items-center justify-center p-8 border-2 border-dashed border-slate-300 rounded-2xl bg-white hover:bg-slate-50 transition-colors cursor-pointer" id="file-drop-zone">
              <input 
                type="file" 
                id="file-input"
                class="hidden" 
                webkitdirectory
                multiple
              />
              <div class="flex flex-col items-center text-slate-500">
                <div class="mb-2 text-indigo-500">${icons.Upload(32)}</div>
                <p class="font-medium">点击选择文件夹或 JSON 文件</p>
                <p class="text-xs text-slate-400 mt-1">支持：原始数据 JSON、含进度的备份文件，或 Mastodon 导出的存档文件夹（需先解压 ZIP）</p>
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

          <!-- 抓取进度与控制 (暂停/停止) -->
          ${state.loading && state.mode === 'url' ? `
            <div class="mt-4 p-4 bg-white rounded-xl shadow-sm border border-indigo-100 animate-fade-in">
              <div class="text-center text-indigo-600 font-medium flex items-center justify-center gap-2 mb-3">
                ${icons.Loader2(16)} <span>已抓取 <span id="fetch-count">${state.fetchCount}</span> 条数据... ${state.isPaused ? '(已暂停)' : ''}</span>
              </div>
              
              <div class="flex justify-center gap-3">
                <button 
                  id="toggle-pause"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 text-sm transition-colors"
                >
                  ${state.isPaused ? `${icons.Play(14)} 继续` : `${icons.Pause(14)} 暂停`}
                </button>
                <button 
                  id="stop-fetch"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-50 text-red-600 hover:bg-red-100 text-sm transition-colors"
                >
                  ${icons.Square(14)} 停止并显示
                </button>
              </div>
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
                  <li><strong>导入 Mastodon 存档</strong>：如果您有 Mastodon 导出的 ActivityPub 格式存档（ZIP 文件），请先解压 ZIP 文件，然后点击"导入本地 JSON 文件"，选择解压后的整个文件夹。这样程序可以读取 <code>outbox.json</code> 和 <code>actor.json</code>，并且可以正常显示存档中包含的图片等媒体文件。</li>
                  <li><strong>网络环境</strong>：本工具为纯本地运行（Static Web App）。能否成功抓取数据和显示图片，完全取决于您的网络环境能否顺畅访问该长毛象实例。</li>
                  <li><strong>含进度备份</strong>：浏览一部分后，可以使用"下载数据 + 进度"保存当前状态，下次导入可继续从上次的位置开始随机浏览。</li>
                  <li><strong>自动加载缓存</strong>：如果您之前抓取过数据，刷新页面后程序会自动加载本地缓存的数据，无需重新抓取。只要您不清除浏览器缓存，就可以随时访问查看。</li>
                </ul>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Loading State (When fetching data initially) -->
      ${state.currentAccount && state.loading && state.fetchType === 'initial' ? `
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

      <!-- 抓取中状态 (Loading Overlay for Older/Newer) -->
      ${state.loading && state.currentAccount && state.fetchType !== 'initial' ? `
        <div class="fixed bottom-4 right-4 bg-white shadow-xl rounded-xl p-4 border border-indigo-100 z-50 animate-fade-in-up flex flex-col gap-2 w-64">
          <div class="flex items-center gap-2 text-indigo-600 font-medium text-sm">
            ${icons.Loader2(16)} <span>正在抓取 ${state.fetchType === 'older' ? '更早' : '更新'} 数据...</span>
          </div>
          <div class="text-xs text-slate-500 text-center">已获取 <span id="fetch-count-incremental">${state.fetchCount}</span> 条 ${state.isPaused ? '(已暂停)' : ''}</div>
          
          <div class="flex gap-2 mt-1">
            <button id="toggle-pause-incremental" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs py-1.5 rounded transition-colors">
              ${state.isPaused ? '继续' : '暂停'}
            </button>
            <button id="stop-fetch-incremental" class="flex-1 bg-red-50 hover:bg-red-100 text-red-600 text-xs py-1.5 rounded transition-colors">
              停止
            </button>
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

          <!-- 2. 筛选与数据管理 (Filter & Fetch More) -->
          <div class="w-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <!-- 筛选头部 -->
            <div 
              class="px-4 py-3 bg-slate-50 border-b border-slate-100 flex justify-between items-center cursor-pointer hover:bg-slate-100 transition-colors"
              id="toggle-filters"
            >
              <div class="flex items-center gap-2 text-slate-700 font-medium text-sm">
                ${icons.Calendar(16)} <span>随机范围筛选 & 数据管理</span>
              </div>
              ${state.showFilters ? icons.ChevronUp(16) : icons.ChevronDown(16)}
            </div>

            <!-- 筛选内容 -->
            ${state.showFilters ? `
              <div class="p-4 space-y-4">
                <!-- 数据范围提示 -->
                ${state.allStatuses.length > 0 ? `
                  <div class="text-xs text-center text-slate-500 bg-slate-50 p-2 rounded border border-slate-100">
                    当前嘟文是从 <span class="font-medium text-slate-700">${new Date(state.allStatuses[0].created_at).toLocaleDateString()}</span> 到 <span class="font-medium text-slate-700">${new Date(state.allStatuses[state.allStatuses.length - 1].created_at).toLocaleDateString()}</span> 之间的
                  </div>
                ` : ''}

                <!-- 日期范围筛选 -->
                <div class="grid grid-cols-2 gap-4">
                  <div class="flex flex-col gap-1">
                    <span class="text-xs text-slate-500">起始日期</span>
                    <input 
                      type="date" 
                      id="filter-start-date"
                      class="border border-slate-300 rounded px-2 py-1 text-sm focus:border-indigo-500 outline-none"
                      value="${state.displayFilter.startDate}"
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-xs text-slate-500">结束日期</span>
                    <input 
                      type="date" 
                      id="filter-end-date"
                      class="border border-slate-300 rounded px-2 py-1 text-sm focus:border-indigo-500 outline-none"
                      value="${state.displayFilter.endDate}"
                    />
                  </div>
                </div>
                
                <!-- 类型筛选 (如果数据里有) -->
                <div class="flex gap-4 text-sm">
                  <label class="flex items-center gap-2 cursor-pointer text-slate-600">
                    <input 
                      type="checkbox" 
                      id="show-replies"
                      class="rounded text-indigo-600 focus:ring-indigo-500"
                      ${state.displayFilter.showReplies ? 'checked' : ''}
                    />
                    显示回复
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer text-slate-600">
                    <input 
                      type="checkbox" 
                      id="show-reblogs"
                      class="rounded text-indigo-600 focus:ring-indigo-500"
                      ${state.displayFilter.showReblogs ? 'checked' : ''}
                    />
                    显示转嘟
                  </label>
                </div>
                <div class="text-xs text-slate-400 italic">提示：如果抓取时已排除了回复/转嘟，此处勾选也无法显示。</div>

                <div class="border-t border-slate-100 my-2"></div>

                <!-- 增量抓取按钮 -->
                <div class="flex gap-2">
                  <button 
                    id="fetch-older"
                    class="flex-1 flex justify-center items-center gap-1.5 py-2 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 text-xs font-medium transition-colors"
                  >
                    ${icons.ArrowDown(14)} 抓取更早的数据
                  </button>
                  <button 
                    id="fetch-newer"
                    class="flex-1 flex justify-center items-center gap-1.5 py-2 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 text-xs font-medium transition-colors"
                  >
                    ${icons.ArrowUp(14)} 抓取更新的数据
                  </button>
                </div>
              </div>
            ` : ''}
          </div>

          <!-- 3. Controls - Below Status -->
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
        <p class="mt-2">
          <span id="busuanzi_container_site_pv">本站总访问量<span id="busuanzi_value_site_pv"></span>次</span>
        </p>
      </footer>
      
      ${fullscreenImageState.currentIndex !== null && fullscreenImageState.images.length > 0 ? `
        <div 
          id="fullscreen-overlay"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4 backdrop-blur-sm animate-fade-in"
        >
          <!-- Close Button -->
          <button 
            id="close-fullscreen"
            class="absolute top-4 right-4 text-white/70 hover:text-white transition-colors p-2 bg-black/20 rounded-full z-50"
          >
            ${icons.X(32)}
          </button>

          <!-- Prev Button -->
          ${fullscreenImageState.currentIndex > 0 ? `
            <button 
              id="prev-image"
              class="absolute left-2 md:left-6 top-1/2 -translate-y-1/2 text-white/70 hover:text-white transition-colors p-2 md:p-3 bg-black/20 hover:bg-black/40 rounded-full z-50"
            >
              ${icons.ChevronLeft(32)}
            </button>
          ` : ''}

          <!-- Image Container -->
          <div 
            class="relative flex flex-col items-center justify-center max-w-full max-h-[90vh]" 
          >
            <img 
              src="${fullscreenImageState.images[fullscreenImageState.currentIndex].url}" 
              alt="${(fullscreenImageState.images[fullscreenImageState.currentIndex].description || 'Fullscreen view').replace(/"/g, '&quot;')}" 
              class="max-w-full max-h-[85vh] object-contain rounded-md shadow-2xl select-none"
            />
            
            <!-- Caption / Description -->
            ${fullscreenImageState.images[fullscreenImageState.currentIndex].description ? `
              <div class="mt-4 text-white/90 text-sm bg-black/50 px-4 py-2 rounded-lg max-w-2xl text-center backdrop-blur-sm">
                ${fullscreenImageState.images[fullscreenImageState.currentIndex].description}
              </div>
            ` : ''}

            <!-- Counter -->
            ${fullscreenImageState.images.length > 1 ? `
              <div class="absolute top-4 left-4 bg-black/50 text-white text-sm px-3 py-1 rounded-full backdrop-blur-sm">
                ${fullscreenImageState.currentIndex + 1} / ${fullscreenImageState.images.length}
              </div>
            ` : ''}
          </div>

          <!-- Next Button -->
          ${fullscreenImageState.currentIndex < fullscreenImageState.images.length - 1 ? `
            <button 
              id="next-image"
              class="absolute right-2 md:right-6 top-1/2 -translate-y-1/2 text-white/70 hover:text-white transition-colors p-2 md:p-3 bg-black/20 hover:bg-black/40 rounded-full z-50"
            >
              ${icons.ChevronRight(32)}
            </button>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;

  // Attach event listeners
  attachEventListeners();
  
  // Setup keyboard navigation
  setupKeyboardNavigation();
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
      const imageIndex = parseInt(e.target.getAttribute('data-image-index'));
      if (isNaN(imageIndex)) return;
      
      // Find all images in current status (check reblog if it's a reblog)
      if (state.currentStatus) {
        const displayStatus = state.currentStatus.reblog || state.currentStatus;
        const mediaAttachments = displayStatus.media_attachments || [];
        const imageAttachments = mediaAttachments.filter(m => m.type === 'image');
        
        if (imageAttachments.length > 0) {
          fullscreenImageState = {
            currentIndex: imageIndex,
            images: imageAttachments.map(img => ({
              url: img.url,
              description: img.description || null,
            })),
          };
          render();
        }
      }
    });
  });

  // Fullscreen overlay - close
  const fullscreenOverlay = document.getElementById('fullscreen-overlay');
  const closeFullscreenBtn = document.getElementById('close-fullscreen');
  if (fullscreenOverlay) {
    fullscreenOverlay.addEventListener('click', (e) => {
      if (e.target === fullscreenOverlay || e.target === closeFullscreenBtn || e.target.closest('#close-fullscreen')) {
        fullscreenImageState = { currentIndex: null, images: [] };
        render();
      }
    });
  }

  // Fullscreen navigation
  const prevImageBtn = document.getElementById('prev-image');
  const nextImageBtn = document.getElementById('next-image');
  if (prevImageBtn) {
    prevImageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fullscreenImageState.currentIndex > 0) {
        fullscreenImageState.currentIndex--;
        render();
      }
    });
  }
  if (nextImageBtn) {
    nextImageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fullscreenImageState.currentIndex < fullscreenImageState.images.length - 1) {
        fullscreenImageState.currentIndex++;
        render();
      }
    });
  }

  // Keyboard navigation for fullscreen images (global handler)
  // This will be set up once and reused

  // 抓取配置事件
  const excludeReplies = document.getElementById('exclude-replies');
  if (excludeReplies) {
    excludeReplies.addEventListener('change', (e) => {
      state.fetchConfig.excludeReplies = e.target.checked;
    });
  }

  const excludeReblogs = document.getElementById('exclude-reblogs');
  if (excludeReblogs) {
    excludeReblogs.addEventListener('change', (e) => {
      state.fetchConfig.excludeReblogs = e.target.checked;
    });
  }

  const fetchModeRadios = document.querySelectorAll('input[name="fetchMode"]');
  fetchModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      state.fetchConfig.mode = e.target.value;
      render(); // Re-render to update disabled states
    });
  });

  const limitCount = document.getElementById('limit-count');
  if (limitCount) {
    limitCount.addEventListener('input', (e) => {
      state.fetchConfig.limitCount = parseInt(e.target.value) || 100;
    });
  }

  const limitDate = document.getElementById('limit-date');
  if (limitDate) {
    limitDate.addEventListener('change', (e) => {
      state.fetchConfig.limitDate = e.target.value;
    });
  }

  // 暂停/停止按钮
  const togglePauseBtn = document.getElementById('toggle-pause');
  if (togglePauseBtn) {
    togglePauseBtn.addEventListener('click', togglePause);
  }

  const stopFetchBtn = document.getElementById('stop-fetch');
  if (stopFetchBtn) {
    stopFetchBtn.addEventListener('click', stopFetch);
  }

  // 增量抓取的暂停/停止按钮
  const togglePauseIncremental = document.getElementById('toggle-pause-incremental');
  if (togglePauseIncremental) {
    togglePauseIncremental.addEventListener('click', togglePause);
  }

  const stopFetchIncremental = document.getElementById('stop-fetch-incremental');
  if (stopFetchIncremental) {
    stopFetchIncremental.addEventListener('click', stopFetch);
  }

  // 显示筛选面板
  const toggleFilters = document.getElementById('toggle-filters');
  if (toggleFilters) {
    toggleFilters.addEventListener('click', () => {
      state.showFilters = !state.showFilters;
      render();
    });
  }

  // 筛选日期
  const filterStartDate = document.getElementById('filter-start-date');
  if (filterStartDate) {
    filterStartDate.addEventListener('change', (e) => {
      state.displayFilter.startDate = e.target.value;
    });
  }

  const filterEndDate = document.getElementById('filter-end-date');
  if (filterEndDate) {
    filterEndDate.addEventListener('change', (e) => {
      state.displayFilter.endDate = e.target.value;
    });
  }

  // 筛选类型
  const showReplies = document.getElementById('show-replies');
  if (showReplies) {
    showReplies.addEventListener('change', (e) => {
      state.displayFilter.showReplies = e.target.checked;
    });
  }

  const showReblogs = document.getElementById('show-reblogs');
  if (showReblogs) {
    showReblogs.addEventListener('change', (e) => {
      state.displayFilter.showReblogs = e.target.checked;
    });
  }}

  // 增量抓取按钮
  const fetchOlder = document.getElementById('fetch-older');
  if (fetchOlder) {
    fetchOlder.addEventListener('click', () => {
      executeFetch('older');
    });
  }

  const fetchNewer = document.getElementById('fetch-newer');
  if (fetchNewer) {
    fetchNewer.addEventListener('click', () => {
      executeFetch('newer');
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

