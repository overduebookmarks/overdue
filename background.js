const action = browser.browserAction;

async function openApp() {
  const tabs = await browser.tabs.query({});

  const existing = tabs.find(t =>
    t.url && t.url.includes("app.html")
  );

  if (existing) {
    browser.tabs.update(existing.id, { active: true });
    browser.windows.update(existing.windowId, { focused: true });
  } else {
    browser.tabs.create({
      url: browser.runtime.getURL("app.html")
    });
  }
}

action.onClicked.addListener(openApp);