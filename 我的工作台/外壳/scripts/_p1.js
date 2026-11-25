(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const tab = document.querySelector('#scenario-tabs .tab[data-sc-id="platforms"]');
  if (tab) { tab.click(); await sleep(2600); }
  const grid = document.querySelector('#grid');
  const gcs = getComputedStyle(grid);
  out.grid = {
    h: Math.round(grid.getBoundingClientRect().height),
    rows: gcs.gridTemplateRows,
    autoRows: gcs.gridAutoRows,
    overflowY: gcs.overflowY,
    scrollH: grid.scrollHeight,
  };
  out.panels = Array.from(grid.querySelectorAll(':scope > .panel[data-panel-id]')).map((p) => {
    const r = p.getBoundingClientRect();
    const wv = p.querySelector('webview');
    return {
      id: p.dataset.panelId,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      inView: r.top >= 0 && r.bottom <= window.innerHeight + 2,
      wv: wv ? [Math.round(wv.getBoundingClientRect().width), Math.round(wv.getBoundingClientRect().height)] : null,
    };
  });
  out.vh = window.innerHeight;
  return out;
})()
