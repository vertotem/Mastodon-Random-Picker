/**
 * Misskey API 工具函数
 * 纯前端 JavaScript，可在浏览器和 Node.js 18+ 中使用
 */

/**
 * 解析 Misskey 用户 URL
 * @param {string} inputUrl - Misskey 用户 URL，例如: https://misskey.io/@username
 * @returns {{domain: string, username: string} | null}
 */
export const parseMisskeyUrl = (inputUrl) => {
  try {
    const url = new URL(inputUrl);
    const domain = url.hostname;
    const pathParts = url.pathname.split('/').filter(p => p);

    // 格式: https://misskey.io/@username
    if (pathParts.length >= 1 && pathParts[0].startsWith('@')) {
      return {
        domain,
        username: pathParts[0].substring(1),
      };
    }
    
    // 格式: https://pari.cafe/users/circuits
    if (pathParts.length >= 2 && pathParts[0] === 'users') {
      return {
        domain,
        username: pathParts[1],
      };
    }

    return null;
  } catch (e) {
    return null;
  }
};

/**
 * 通过用户名获取用户 ID
 * @param {string} instanceDomain - Misskey 实例域名，例如: pari.cafe
 * @param {string} username - 用户名，例如: circuits
 * @param {string} [host] - 远程用户的实例域名（可选）
 * @param {string} [token] - 访问令牌（可选）
 * @returns {Promise<string>} 用户 ID
 */
export const getUserId = async (instanceDomain, username, host = null, token = null) => {
  const apiUrl = `https://${instanceDomain}/api/users/show`;
  
  const body = {
    username: username,
  };
  
  if (host) {
    body.host = host;
  }
  
  if (token) {
    body.i = token;
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`获取用户信息失败: ${response.status} ${response.statusText}`);
  }

  const userData = await response.json();
  
  if (!userData.id) {
    throw new Error('用户数据中未找到 ID 字段');
  }

  return userData.id;
};

/**
 * 获取用户的所有帖子（Notes）
 * @param {string} instanceDomain - Misskey 实例域名
 * @param {string} userId - 用户 ID
 * @param {Object} [options] - 选项
 * @param {string} [options.token] - 访问令牌（可选）
 * @param {number} [options.limit] - 每次请求的帖子数量（默认 100，最大 100）
 * @param {boolean} [options.includeReplies] - 是否包含回复（默认 true）
 * @param {boolean} [options.includeRenotes] - 是否包含转发（默认 true）
 * @param {Function} [options.onProgress] - 进度回调函数 (currentCount, totalCount)
 * @param {Function} [options.shouldStop] - 返回 true 时中断抓取
 * @param {Function} [options.shouldPause] - 返回 true 时暂停（轮询）
 * @returns {Promise<Array>} 所有帖子的数组
 */
export const getAllNotes = async (
  instanceDomain,
  userId,
  options = {}
) => {
  const {
    token = null,
    limit = 100,
    includeReplies = true,
    includeRenotes = true,
    onProgress = null,
    shouldStop = () => false,
    shouldPause = () => false,
  } = options;

  const apiUrl = `https://${instanceDomain}/api/users/notes`;
  const allNotes = [];
  let untilId = null;
  let hasMore = true;
  let totalFetched = 0;

  while (hasMore) {
    // 停止
    if (shouldStop()) break;
    // 暂停轮询
    while (shouldPause()) {
      await new Promise((r) => setTimeout(r, 300));
      if (shouldStop()) break;
    }
    if (shouldStop()) break;

    const body = {
      userId: userId,
      limit: limit,
      includeReplies: includeReplies,
      includeRenotes: includeRenotes,
    };

    if (token) {
      body.i = token;
    }

    if (untilId) {
      body.untilId = untilId;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`获取帖子失败: ${response.status} ${response.statusText}`);
    }

    const notes = await response.json();

    if (!Array.isArray(notes)) {
      throw new Error('API 返回的数据格式不正确');
    }

    if (notes.length === 0) {
      hasMore = false;
      break;
    }

    allNotes.push(...notes);
    totalFetched += notes.length;

    // 调用进度回调
    if (onProgress) {
      onProgress(totalFetched, null);
    }

    // 如果返回的帖子数量少于 limit，说明已经获取完所有帖子
    if (notes.length < limit) {
      hasMore = false;
    } else {
      // 获取最旧一条帖子的 ID 作为下次请求的 untilId
      untilId = notes[notes.length - 1].id;
    }
  }

  return allNotes;
};

/**
 * 从 Misskey URL 获取所有帖子的完整 JSON 数据
 * @param {string} misskeyUrl - Misskey 用户 URL，例如: https://misskey.io/@username
 * @param {Object} [options] - 选项
 * @param {string} [options.token] - 访问令牌（可选）
 * @param {number} [options.limit] - 每次请求的帖子数量（默认 100）
 * @param {boolean} [options.includeReplies] - 是否包含回复（默认 true）
 * @param {boolean} [options.includeRenotes] - 是否包含转发（默认 true）
 * @param {Function} [options.onProgress] - 进度回调函数 (currentCount, totalCount)
 * @returns {Promise<Array<Object>>} 所有帖子的完整 JSON 数据数组
 */
export const getAllNotesData = async (misskeyUrl, options = {}) => {
  // 解析 URL
  const parsed = parseMisskeyUrl(misskeyUrl);
  if (!parsed) {
    throw new Error(`无法解析 Misskey URL: ${misskeyUrl}`);
  }

  const { domain, username } = parsed;

  // 获取用户 ID
  const userId = await getUserId(domain, username, null, options.token);

  // 获取所有帖子的完整数据
  const notes = await getAllNotes(domain, userId, options);

  return notes;
};

/**
 * 获取 Misskey 实例的自定义表情列表，返回 map { shortcode 或 alias : url }
 * @param {string} instanceDomain - Misskey 实例域名
 * @param {Object} [options]
 * @param {string} [options.token] - 访问令牌（可选）
 * @returns {Promise<Object>} 表情映射
 */
export const getInstanceEmojis = async (instanceDomain, options = {}) => {
  const { token = null } = options;
  const emojiUrl = `https://${instanceDomain}/api/emojis`;
  const body = {};
  if (token) body.i = token;

  const map = {};

  // Helper to merge emoji array into map
  const mergeEmojis = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((emoji) => {
      if (!emoji || !emoji.name || !emoji.url) return;
      // name 可能包含远端 host（例如 name@host），去掉 host 也存一份
      map[emoji.name] = emoji.url;
      if (emoji.name.includes('@')) {
        const short = emoji.name.split('@')[0];
        if (short) map[short] = emoji.url;
      }
      if (Array.isArray(emoji.aliases)) {
        emoji.aliases.forEach((alias) => {
          if (alias) map[alias] = emoji.url;
        });
      }
    });
  };

  // Normalize API response to an array
  const toArray = (json) => {
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.emojis)) return json.emojis;
    return [];
  };

  // 1) Fetch /api/emojis only (confirmed endpoint)
  // Prefer POST; fallback to GET if POST fails or is blocked.
  let emojiFetched = false;
  try {
    const res = await fetch(emojiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const list = toArray(await res.json());
      mergeEmojis(list);
      emojiFetched = true;
    }
  } catch (e) {
    console.warn('POST /api/emojis failed, will try GET:', e);
  }

  if (!emojiFetched) {
    const res2 = await fetch(emojiUrl, { method: 'GET' });
    if (!res2.ok) {
      throw new Error(`获取实例表情失败: ${res2.status} ${res2.statusText}`);
    }
    const list = toArray(await res2.json());
    mergeEmojis(list);
  }

  return map;
};

