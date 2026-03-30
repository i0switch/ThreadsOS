import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError, ExternalApiError } from "../../app/errors.js";
import { logger } from "../../app/logger.js";

export type NotificationChannel = "progress" | "action_needed" | "alert" | "critical" | "recovery";

export interface NotifierClient {
  send(
    channel: NotificationChannel,
    content: string,
  ): Promise<{ id: string; channel: NotificationChannel; destination: string }>;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function wrapDiscordMessage(
  channel: NotificationChannel,
  content: string,
): string {
  const prefix = {
    progress: "[progress]",
    action_needed: "[action-needed]",
    alert: "[alert]",
    critical: "[CRITICAL]",
    recovery: "[recovery]",
  }[channel];

  return `${prefix}\n${content}`.slice(0, 1900);
}

export class FileNotifier implements NotifierClient {
  constructor(private readonly baseDir = "docs/notifications") {}

  async send(
    channel: NotificationChannel,
    content: string,
  ): Promise<{
    id: string;
    channel: NotificationChannel;
    destination: string;
  }> {
    const id = timestampId();
    const destination = join(this.baseDir, `${id}-${channel}.md`);
    const fullPath = resolve(destination);

    await mkdir(resolve(this.baseDir), { recursive: true });
    await writeFile(fullPath, `# ${channel}\n\n${content}\n`, "utf8");

    logger.info(
      { channel, destination: fullPath },
      "File notification written",
    );
    return { id, channel, destination: fullPath };
  }
}

export class DiscordWebhookNotifier implements NotifierClient {
  constructor(private readonly webhookUrl: string) {}

  async send(
    channel: NotificationChannel,
    content: string,
  ): Promise<{
    id: string;
    channel: NotificationChannel;
    destination: string;
  }> {
    if (!this.webhookUrl) {
      throw new AppError(
        "NOTIFICATION_DISCORD_WEBHOOK が未設定",
        "NOTIFIER_CONFIG_ERROR",
        500,
      );
    }

    const payload = {
      content: wrapDiscordMessage(channel, content),
    };

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ExternalApiError(
        "Discord webhook",
        `${response.status}: ${body.slice(0, 500)}`,
      );
    }

    const id = timestampId();
    logger.info({ channel }, "Discord notification sent");
    return { id, channel, destination: "discord" };
  }
}


export function createNotifier(
  options: { discordWebhookUrl?: string; fileDir?: string } = {},
): NotifierClient {
  if (options.discordWebhookUrl) {
    return new DiscordWebhookNotifier(options.discordWebhookUrl);
  }
  return new FileNotifier(options.fileDir);
}
