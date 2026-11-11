export async function revealControl(locator) {
  const stage = await locator.evaluate(element => element.closest('[data-publish-stage]')?.dataset.publishStage);
  if (stage && !await locator.isVisible()) {
    await locator.page().locator(`[data-publish-goto="${stage}"]`).click();
  }
  for (;;) {
    const handle = await locator.evaluateHandle(element => {
      const closed = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.open) closed.push(parent);
      }
      return closed.at(-1)?.querySelector(':scope > summary') || null;
    });
    const summary = handle.asElement();
    if (!summary) { await handle.dispose(); return; }
    await summary.click();
    await handle.dispose();
  }
}

export async function revealDetails(page, selector) {
  for (const details of await page.locator(selector).all()) {
    const summary = details.locator(':scope > summary');
    await revealControl(summary);
    if (!await details.evaluate(element => element.open)) await summary.click();
  }
}
