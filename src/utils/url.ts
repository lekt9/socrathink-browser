export const isURL = (input: string): boolean => {
  const pattern = /^(?:\w+:)?\/\/([^\s.]+\.\S{2}|localhost[:?\d]*)\S*$/;

  if (pattern.test(input)) {
    return true;
  }
  return pattern.test(`https://${input}`);
};

export const matchesPattern = (pattern: string, url: string) => {
  if (pattern === '<all_urls>') {
    return true;
  }

  const regexp = new RegExp(
    `^${pattern.replace(/\*/g, '.*').replace('/', '\\/')}$`,
  );
  return url.match(regexp) != null;
};

export const getDomain = (url: string): string => {
  let hostname = url;

  if (hostname.includes('https://') || hostname.includes('https://')) {
    hostname = hostname.split('://')[1];
  }

  if (hostname.includes('?')) {
    hostname = hostname.split('?')[0];
  }

  if (hostname.includes('://')) {
    hostname = `${hostname.split('://')[0]}://${hostname.split('/')[2]}`;
  } else {
    hostname = hostname.split('/')[0];
  }

  return hostname;
};

export const prefixHttp = (url: string): string => {
  url = url.trim();
  return url.includes('://') ? url : `https://${url}`;
};


// export const extractQueryParams = (url: string): { strippedUrl: string, params: Record<string, string> } => {
//   try {
//     const urlObj = new URL(url);
//     const searchParams = new URLSearchParams(urlObj.search);
//     const params: Record<string, string> = {};

//     for (const [key, value] of searchParams.entries()) {
//       params[key] = value;
//     }

//     const strippedUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

//     return { strippedUrl, params };
//   }
//   catch {
//     return { strippedUrl: url, params: {} };
//   }
// };

export const extractQueryParams = (url: string): { strippedUrl: string, params: Record<string, string> } => {
  try {
    const [baseUrl, queryString] = url.split('?');
    const params: Record<string, string> = {};

    if (queryString) {
      const queryParams = new URLSearchParams(queryString);
      queryParams.forEach((value, key) => {
        if (key.startsWith('utm_')) {
          params[key] = value;
        }
      });
    }

    const strippedUrl = queryString
      ? `${baseUrl}?${queryString.split('&').filter(param => !param.startsWith('utm_')).join('&')}`
      : baseUrl;

    console.log({ strippedUrl })

    return { strippedUrl, params };
  }
  catch {
    return { strippedUrl: url, params: {} };
  }
};