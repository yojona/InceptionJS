// Some browser contexts expose the origin private file system and fail it
// (Playwright's WebKit, Safari private windows): nothing persists there, so a
// test of data surviving a restart has nothing to check.
export async function requirePersistentStorage(test, page) {
  await page.goto('/package.json');
  const usable = await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.getFileHandle('.persistence-check', { create: true });
      return true;
    } catch {
      return false;
    }
  });
  test.skip(!usable, 'the origin private file system does not work in this browser context');
}
