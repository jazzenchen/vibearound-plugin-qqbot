#!/usr/bin/env node
/**
 * VibeAround QQ Bot Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * Communicates via ACP protocol (JSON-RPC 2.0 over stdio).
 *
 * QQ Guild Bot uses WebSocket gateway — no public IP required.
 */

// MUST be the first import — guards stdout from qq-guild-bot SDK loglevel output
import "./stdout-guard.js";

import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";

import { QQBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

runChannelPlugin({
  name: "vibearound-qqbot",
  version: "0.1.0",
  requiredConfig: ["app_id", "secret"],
  createBot: ({ config, agent, log, cacheDir }) =>
    new QQBot(
      { app_id: config.app_id as string, secret: config.secret as string },
      agent,
      log,
      cacheDir,
    ),
  createRenderer: (bot, log, verbose) =>
    new AgentStreamHandler(bot, log, verbose),
});
