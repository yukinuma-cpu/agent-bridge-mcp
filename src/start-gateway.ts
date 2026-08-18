#!/usr/bin/env node
import { GatewayServer } from "./gateway/gateway-server.js";

// 設定はすべて GatewayServer 側で環境変数から解決する（既定トークンは持たせない）。
//   ABC_AUTH_TOKEN            必須。共有シークレット
//   PORT                      既定 3030
//   AGENT_BRIDGE_HOST         既定 127.0.0.1
//   AGENT_BRIDGE_WORKSPACE    project 名を解決する基準ディレクトリ（既定 cwd）
//   AGENT_BRIDGE_ROOT         状態ファイルの保存先（既定 cwd）
const server = new GatewayServer();

server.start().catch((err) => {
  console.error("Failed to start Agent Bridge Gateway:", err.message);
  process.exit(1);
});
