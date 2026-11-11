// Expose a retained feature only inside isolated UI tests and visual verification.
// Production pages continue to use their normal hidden navigation configuration.
export function exposeHiddenNavigationSource(source, pageName) {
  const declaration = /const hiddenNavPages=new Set\([^;]+;/;
  if (!declaration.test(source)) throw new Error('Hidden navigation configuration was not found');
  return source.replace(declaration, value => value + '\n' + 'hiddenNavPages.delete(' + JSON.stringify(pageName) + ');');
}

export async function exposeHiddenNavigation(page, pageName) {
  await page.route(/\/app\.js(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = exposeHiddenNavigationSource(await response.text(), pageName);
    await route.fulfill({ response, body });
  });
}
