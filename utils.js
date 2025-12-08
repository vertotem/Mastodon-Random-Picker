export const parseMastodonUrl = (inputUrl) => {
  try {
    const url = new URL(inputUrl);
    const domain = url.hostname;
    const pathParts = url.pathname.split('/').filter(p => p);

    // Common format: https://alive.bar/@meomo
    // pathParts[0] should be @username
    if (pathParts.length >= 1 && pathParts[0].startsWith('@')) {
      return {
        domain,
        username: pathParts[0].substring(1),
      };
    }
    
    // Alternative format: https://alive.bar/users/meomo
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

export const formatDate = (dateString) => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

export const downloadJson = (data, filename) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

