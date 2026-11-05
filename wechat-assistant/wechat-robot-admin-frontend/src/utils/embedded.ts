export const workbenchPath = '/wechat-workbench';
export const isEmbedded = window.location.pathname === workbenchPath || window.location.pathname.startsWith(`${workbenchPath}/`);
export const appBasePath = isEmbedded ? workbenchPath : '';

/** Keep uploads, media and streaming requests on the authenticated Tianhe gateway. */
export const robotUrl = (path: string) => `${appBasePath}${path}`;
