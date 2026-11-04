import { existsSync } from "node:fs";
import { defaultWebDist, startWebServer } from "../web/server.js";

export interface WebCliOptions {
  port?: string;
  host?: string;
  dev?: boolean;
}

export async function runWeb(opts: WebCliOptions): Promise<number> {
  const port = opts.port === undefined ? 4173 : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${opts.port ?? ""}`);
    return 1;
  }
  const host = opts.host?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.warn(
      `警告: 正在绑定 ${host}。这个服务会读写本机项目路径，默认应只监听 127.0.0.1。`,
    );
  }
  if (!opts.dev && !existsSync(defaultWebDist())) {
    console.error("Web UI assets not found at web/dist.");
    console.error("Run `npm run web` or `npm run build:web` first.");
    return 1;
  }

  const started = await startWebServer({
    host,
    port,
    dev: opts.dev,
  });
  console.log(`acb web  ${started.url}`);
  console.log("Local only. Export, import, summarize, and repair stay on this machine.");
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const stop = () => {
      started.close().finally(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
