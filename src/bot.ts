/**
 * QQBot — wraps the QQ Bot v2 platform (q.qq.com / 开放平台).
 *
 * Uses Tencent's official `@tencent-connect/openclaw-qqbot` package for the
 * authenticated HTTP APIs (token fetch, gateway URL fetch, message sending),
 * and implements a minimal custom WebSocket loop with `ws` for the gateway.
 *
 * Why not use that package's `startGateway()` directly? It's tightly coupled
 * to OpenClaw's plugin SDK runtime types. We bypass it and use only the pure
 * api functions, which have no openclaw dependencies.
 *
 * Auth flow:
 *   1. POST https://bots.qq.com/app/getAppAccessToken { appId, clientSecret } → access_token
 *   2. GET https://api.sgroup.qq.com/v2/gateway/bot → wss URL
 *   3. WebSocket connect → receive HELLO (op=10)
 *   4. Send IDENTIFY (op=2) with token + intents
 *   5. Receive READY (op=0, t="READY")
 *   6. Heartbeat (op=1) every heartbeat_interval ms
 *   7. Handle dispatch events (op=0): C2C_MESSAGE_CREATE, GROUP_AT_MESSAGE_CREATE, etc.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  getAccessToken,
  getGatewayUrl,
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendDmMessage,
  setApiLogger,
} from "@tencent-connect/openclaw-qqbot/dist/src/api.js";
import WebSocket from "ws";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";

interface DownloadedAttachment {
  readonly path: string;
  readonly mimeType: string;
  readonly fileName: string;
}

export interface QQBotConfig {
  app_id: string;
  /** AppSecret from QQ Open Platform. Accepts either the raw secret or "appid:secret". */
  secret: string;
}

type LogFn = (level: string, msg: string) => void;

// QQ Bot intents — bit flags from openclaw-qqbot gateway.js:274
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
};
const FULL_INTENTS =
  INTENTS.PUBLIC_GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGE |
  INTENTS.GROUP_AND_C2C |
  INTENTS.INTERACTION;

interface PendingContext {
  /** Original inbound message id (used as msg_id for passive replies). */
  msgId: string;
  /** Reply target identifier (varies by chat type). */
  target: string;
  /** Chat kind. */
  kind: "c2c" | "group" | "channel" | "dm";
}

interface DispatchAuthor {
  id?: string;
  username?: string;
  user_openid?: string;
  member_openid?: string;
}

interface DispatchAttachment {
  /** e.g. "image/jpeg", "voice/silk", "application/octet-stream" */
  content_type?: string;
  /** Short-lived signed URL from QQ CDN — no auth needed to fetch. */
  url?: string;
  filename?: string;
  /** Voice ASR transcript (QQ-provided). */
  asr_refer_text?: string;
}

interface DispatchEvent {
  id: string;
  content?: string;
  author?: DispatchAuthor;
  channel_id?: string;
  guild_id?: string;
  group_openid?: string;
  /** Rich-media attachments (images, voice, files). Missing when text-only. */
  attachments?: DispatchAttachment[];
}

export class QQBot {
  private appId: string;
  private clientSecret: string;
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private streamHandler: AgentStreamHandler | null = null;

  private accessToken: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  /** chatId → context for the most recent inbound message. */
  private pending = new Map<string, PendingContext>();

  constructor(config: QQBotConfig, agent: Agent, log: LogFn, cacheDir: string) {
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;
    this.appId = config.app_id;

    // Accept either raw secret or "appid:secret" combined format
    const rawSecret = config.secret;
    if (rawSecret.includes(":")) {
      const [, secretPart] = rawSecret.split(":", 2);
      this.clientSecret = secretPart;
    } else {
      this.clientSecret = rawSecret;
    }

    // Pipe Tencent's api logger into our log function
    setApiLogger({
      info: (msg: string) => log("info", `[qqbot-api] ${msg}`),
      error: (msg: string) => log("error", `[qqbot-api] ${msg}`),
      warn: (msg: string) => log("warn", `[qqbot-api] ${msg}`),
      debug: (msg: string) => log("debug", `[qqbot-api] ${msg}`),
    });
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  /** Get a fresh access token (cached internally by the API helper). */
  private async ensureToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    this.accessToken = await getAccessToken(this.appId, this.clientSecret);
    return this.accessToken;
  }

  async sendText(chatId: string, content: string): Promise<void> {
    const ctx = this.pending.get(chatId);
    if (!ctx) {
      this.log("warn", `no pending context for chat=${chatId}, dropping reply`);
      return;
    }
    try {
      const token = await this.ensureToken();
      switch (ctx.kind) {
        case "c2c":
          await sendC2CMessage(token, ctx.target, content, ctx.msgId);
          break;
        case "group":
          await sendGroupMessage(token, ctx.target, content, ctx.msgId);
          break;
        case "channel":
          await sendChannelMessage(token, ctx.target, content, ctx.msgId);
          break;
        case "dm":
          await sendDmMessage(token, ctx.target, content, ctx.msgId);
          break;
      }
    } catch (e) {
      const err = e as { message?: string };
      this.log("error", `sendText failed: ${err.message ?? String(e)}`);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    try {
      const token = await this.ensureToken();
      const gatewayUrl = await getGatewayUrl(token);
      this.log("info", `QQ Bot connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      ws.on("open", () => {
        this.log("info", "QQ Bot WebSocket open, waiting for HELLO");
      });

      ws.on("message", (data) => {
        try {
          this.handleFrame(JSON.parse(data.toString()));
        } catch (e) {
          this.log("error", `failed to parse frame: ${e}`);
        }
      });

      ws.on("close", (code, reason) => {
        this.log("warn", `QQ Bot WebSocket closed: code=${code} reason=${reason.toString()}`);
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.log("error", `QQ Bot WebSocket error: ${err.message}`);
      });
    } catch (e) {
      const err = e as { message?: string };
      this.log("error", `QQ Bot connect failed: ${err.message ?? String(e)}`);
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(this.reconnectAttempts, delays.length - 1)];
    this.reconnectAttempts++;
    this.log("info", `QQ Bot reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (!this.stopped) void this.connect();
    }, delay);
  }

  private handleFrame(frame: { op: number; d?: unknown; s?: number; t?: string }): void {
    const { op, d, s, t } = frame;

    if (typeof s === "number") {
      this.lastSeq = s;
    }

    switch (op) {
      case 10: {
        // HELLO — send IDENTIFY and start heartbeat
        const helloData = (d ?? {}) as { heartbeat_interval?: number };
        const interval = helloData.heartbeat_interval ?? 30000;

        // Send IDENTIFY
        if (this.accessToken) {
          this.ws?.send(
            JSON.stringify({
              op: 2,
              d: {
                token: `QQBot ${this.accessToken}`,
                intents: FULL_INTENTS,
                shard: [0, 1],
              },
            }),
          );
          this.log("info", `QQ Bot sent IDENTIFY (intents=${FULL_INTENTS})`);
        }

        // Start heartbeat
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
          }
        }, interval);
        break;
      }

      case 0: {
        // DISPATCH
        switch (t) {
          case "READY": {
            const readyData = (d ?? {}) as { session_id?: string; user?: { username?: string } };
            this.sessionId = readyData.session_id ?? null;
            this.reconnectAttempts = 0;
            this.log(
              "info",
              `QQ Bot READY — session=${this.sessionId} user=${readyData.user?.username ?? "?"}`,
            );
            break;
          }
          case "C2C_MESSAGE_CREATE":
            void this.handleC2CMessage(d as DispatchEvent);
            break;
          case "AT_MESSAGE_CREATE":
            void this.handleAtMessage(d as DispatchEvent);
            break;
          case "DIRECT_MESSAGE_CREATE":
            void this.handleDmMessage(d as DispatchEvent);
            break;
          case "GROUP_AT_MESSAGE_CREATE":
            void this.handleGroupAtMessage(d as DispatchEvent);
            break;
          default:
            this.log("debug", `QQ Bot dispatch ignored: t=${t}`);
        }
        break;
      }

      case 11: // Heartbeat ACK
        break;

      default:
        this.log("debug", `QQ Bot frame ignored: op=${op}`);
    }
  }

  private stripMention(content: string): string {
    return content.replace(/<@!?\d+>/g, "").trim();
  }

  private async handleC2CMessage(event: DispatchEvent): Promise<void> {
    const text = this.stripMention(event.content ?? "");
    const senderOpenid = event.author?.user_openid;
    if (!senderOpenid) return;
    if (!text && !event.attachments?.length) return;

    const chatId = `c2c:${senderOpenid}`;
    this.pending.set(chatId, { msgId: event.id, target: senderOpenid, kind: "c2c" });
    this.log(
      "debug",
      `c2c chat=${chatId} text=${text.slice(0, 80)} attachments=${event.attachments?.length ?? 0}`,
    );
    await this.dispatchPrompt(chatId, text, event.attachments);
  }

  private async handleGroupAtMessage(event: DispatchEvent): Promise<void> {
    const text = this.stripMention(event.content ?? "");
    const groupOpenid = event.group_openid;
    if (!groupOpenid) return;
    if (!text && !event.attachments?.length) return;

    const chatId = `group:${groupOpenid}`;
    this.pending.set(chatId, { msgId: event.id, target: groupOpenid, kind: "group" });
    this.log(
      "debug",
      `group chat=${chatId} text=${text.slice(0, 80)} attachments=${event.attachments?.length ?? 0}`,
    );
    await this.dispatchPrompt(chatId, text, event.attachments);
  }

  private async handleAtMessage(event: DispatchEvent): Promise<void> {
    const text = this.stripMention(event.content ?? "");
    const channelId = event.channel_id;
    if (!channelId) return;
    if (!text && !event.attachments?.length) return;

    const chatId = `channel:${channelId}`;
    this.pending.set(chatId, { msgId: event.id, target: channelId, kind: "channel" });
    this.log(
      "debug",
      `channel chat=${chatId} text=${text.slice(0, 80)} attachments=${event.attachments?.length ?? 0}`,
    );
    await this.dispatchPrompt(chatId, text, event.attachments);
  }

  private async handleDmMessage(event: DispatchEvent): Promise<void> {
    const text = this.stripMention(event.content ?? "");
    const guildId = event.guild_id;
    if (!guildId) return;
    if (!text && !event.attachments?.length) return;

    const chatId = `dm:${guildId}`;
    this.pending.set(chatId, { msgId: event.id, target: guildId, kind: "dm" });
    this.log(
      "debug",
      `dm chat=${chatId} text=${text.slice(0, 80)} attachments=${event.attachments?.length ?? 0}`,
    );
    await this.dispatchPrompt(chatId, text, event.attachments);
  }

  private async dispatchPrompt(
    chatId: string,
    text: string,
    attachments?: DispatchAttachment[],
  ): Promise<void> {
    const contentBlocks: ContentBlock[] = [];

    if (text) {
      contentBlocks.push({ type: "text", text });
    }

    const downloaded: DownloadedAttachment[] = [];
    for (const attachment of attachments ?? []) {
      if (!attachment.url) continue;
      const local = await this.downloadAttachment(chatId, attachment).catch(
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log("warn", `failed to download attachment ${attachment.url}: ${msg}`);
          return null;
        },
      );
      if (local) downloaded.push(local);
    }

    if (!text && downloaded.length > 0) {
      contentBlocks.push({
        type: "text",
        text: `The user sent ${downloaded.length} file${downloaded.length > 1 ? "s" : ""}.`,
      });
    }

    for (const file of downloaded) {
      contentBlocks.push({
        type: "resource_link",
        uri: `file://${file.path}`,
        name: file.fileName,
        mimeType: file.mimeType,
      });
    }

    if (contentBlocks.length === 0) return;

    this.streamHandler?.onPromptSent(chatId);

    try {
      const response = await this.agent.prompt({
        sessionId: chatId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done chat=${chatId} stopReason=${response.stopReason}`);
      this.streamHandler?.onTurnEnd(chatId);
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
      this.log("error", `prompt failed chat=${chatId}: ${errMsg}`);
      this.streamHandler?.onTurnError(chatId, errMsg);
    }
  }

  /**
   * Download a QQ attachment into the plugin cache. Files are keyed by
   * chatId + the last segment of the URL path so repeated references
   * to the same file don't re-download.
   */
  private async downloadAttachment(
    chatId: string,
    attachment: DispatchAttachment,
  ): Promise<DownloadedAttachment> {
    const url = attachment.url!;
    const contentType = attachment.content_type ?? "application/octet-stream";

    const safeChannel = chatId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = path.join(this.cacheDir, "qqbot", safeChannel);

    // Build a stable filename: prefer the supplied filename, else derive
    // from the URL path. Strip query strings which contain signatures.
    const urlPath = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })();
    const baseFromUrl = path.basename(urlPath).replace(/[^a-zA-Z0-9._-]/g, "_");
    const supplied = (attachment.filename ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
    const baseName = supplied || baseFromUrl || `${Date.now()}`;
    const extHint = path.extname(baseName) || extFromMime(contentType);
    const fileName = baseName.includes(".")
      ? baseName
      : `${baseName}${extHint}`;
    const localPath = path.join(dir, fileName);

    try {
      await fs.access(localPath);
      this.log("debug", `qqbot attachment cache hit: ${localPath}`);
      return { path: localPath, mimeType: contentType, fileName };
    } catch {
      // not cached
    }

    this.log(
      "debug",
      `downloading qqbot attachment chat=${chatId} url=${url}`,
    );
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching attachment`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(localPath, buf);
    this.log(
      "debug",
      `cached qqbot attachment ${buf.length} bytes → ${localPath}`,
    );

    return { path: localPath, mimeType: contentType, fileName };
  }
}

function extFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("silk")) return ".silk";
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("mp3")) return ".mp3";
  if (lower.includes("mp4")) return ".mp4";
  return "";
}
