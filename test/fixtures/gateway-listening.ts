// Run the real gateway with a stub agent server per supervised agent: it binds its PORT on loopback, answers every RPC
// (its owner identity, and `{ from: "child" }` otherwise), and says it is listening the way an agent server does.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
childProcess.spawn = ((_file: string, _args: string[], options: object) => spawn(process.execPath, ["-e", `
  const http = require('node:http'), port = Number(process.env.PORT);
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      const path = req.url.replace(/^\\/rpc\\//, '').split('?')[0];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ json: path === 'ownerIdentity'
        ? { agentId: 'a'.repeat(64), owner: { type: 'near', account_id: 'owner.near' } } : { from: 'child' } }));
    });
  });
  server.on('error', () => process.exit(1));
  server.listen(port, '127.0.0.1', () => { require('node:fs').writeFileSync('child-' + port + '.pid', String(process.pid)); process.send?.({ type: 'listening', port }); process.channel?.unref(); });
`], options)) as typeof childProcess.spawn;
syncBuiltinESMExports();
await import("../../src/gateway/server.js");
