import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import localtunnel from "localtunnel";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const port = Number(process.env.TUNNEL_PORT || 8787);
const outFile = path.join(ROOT, "localtunnel-url.txt");

const tunnel = await localtunnel({ port });
fs.writeFileSync(outFile, `${tunnel.url}\n`, "utf8");
console.log(tunnel.url);

const keepAlive = () => {};
setInterval(keepAlive, 1 << 30);

tunnel.on("close", () => {
  process.exit(0);
});
