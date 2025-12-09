// Simple Mastodon API probe for a profile URL.
// Usage: `node test-masto.js https://gts.feddit.social/@mengmo`
const inputUrl = process.argv[2] || 'https://gts.feddit.social/@mengmo';
let accessToken = process.env.MASTO_TOKEN || '';

const parseProfileUrl = (raw) => {
  const u = new URL(raw);
  const path = u.pathname.replace(/\/+$/, '');
  const match = path.match(/^\/@([^/]+)$/);
  if (!match) {
    throw new Error(`Unsupported profile path: ${u.pathname}`);
  }
  return { domain: u.hostname, username: match[1] };
};

const fetchJson = async (url, init = {}) => {
  const res = await fetch(url, init);
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}\n${bodyText}`);
    err.status = res.status;
    err.body = bodyText;
    throw err;
  }
  return bodyText ? JSON.parse(bodyText) : null;
};

const readline = async (prompt) => {
  process.stdout.write(prompt);
  return await new Promise((resolve) => {
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
};

const ensureToken = async () => {
  if (accessToken) return accessToken;
  accessToken = await readline('访问需要 Token，请输入（不会保存）：');
  return accessToken;
};

const authHeaders = async () => {
  const token = await ensureToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
};

const main = async () => {
  const { domain, username } = parseProfileUrl(inputUrl);
  console.log(`Domain: ${domain}, username: ${username}`);

  // 1) Lookup account to get id
  const lookupUrl = `https://${domain}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`;
  console.log(`\nGET ${lookupUrl}`);

  let account;
  try {
    account = await fetchJson(lookupUrl);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      console.warn(`Lookup failed (${err.status}), trying with token...`);
      const headers = await authHeaders();
      account = await fetchJson(lookupUrl, { headers });
    } else if (err.status === 404) {
      console.warn(`Lookup failed (${err.status}), trying unauthenticated search...`);
      const searchUrl = `https://${domain}/api/v2/search?q=${encodeURIComponent(`@${username}@${domain}`)}&type=accounts&resolve=true&limit=1`;
      console.log(`GET ${searchUrl}`);
      const search = await fetchJson(searchUrl);
      account = search?.accounts?.[0];
    } else {
      throw err;
    }
  }

  if (!account) {
    throw new Error('Account not found via lookup or search');
  }

  console.log('Account response (trimmed):', {
    id: account.id,
    username: account.username,
    acct: account.acct,
    url: account.url,
  });

  // 2) Fetch a few statuses for this account
  const statusesUrl = `https://${domain}/api/v1/accounts/${account.id}/statuses?limit=5&exclude_replies=true&exclude_reblogs=true`;
  console.log(`\nGET ${statusesUrl}`);

  let statuses;
  try {
    statuses = await fetchJson(statusesUrl);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      console.warn(`Statuses fetch failed (${err.status}), retrying with token...`);
      const headers = await authHeaders();
      statuses = await fetchJson(statusesUrl, { headers });
    } else {
      throw err;
    }
  }

  console.log(`Fetched ${statuses.length} statuses`);
  statuses.slice(0, 3).forEach((s, idx) => {
    console.log(`\nStatus #${idx + 1}`);
    console.log('id:', s.id);
    console.log('created_at:', s.created_at);
    console.log('content:', s.content);
  });
};

main().catch((err) => {
  console.error('Failed:', err);
  process.exitCode = 1;
});

