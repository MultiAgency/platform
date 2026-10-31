// Test stacks only (preloaded through NODE_OPTIONS by environment.mjs, so a gateway's hosted agents inherit it): a
// service whose starter died without stopping it is reparented, and then shuts itself down through its own SIGTERM
// handling instead of running on with its ports and state.
const parent = process.ppid;
const watch = setInterval(() => {
  if (process.ppid === parent) return;
  clearInterval(watch);
  process.kill(process.pid, 'SIGTERM');
  setTimeout(() => process.exit(1), 5_000).unref();
}, 500);
watch.unref();
