import { randomUUID } from "node:crypto";
import type { Context, Store } from "@emulators/core";
import { isSlackConnectChannel } from "./connect.js";
import { getSlackStore } from "./store.js";

export function buildSlackEventEnvelope(store: Store, teamId: string, event: Record<string, unknown>) {
  const ss = getSlackStore(store);
  const channelId =
    typeof event.channel === "string"
      ? event.channel
      : ((event.channel as { id?: string } | undefined)?.id ??
        (event.item as { channel?: string } | undefined)?.channel ??
        (typeof event.channel_id === "string" ? event.channel_id : undefined));
  const channel = channelId ? ss.channels.findOneBy("channel_id", channelId) : undefined;
  const shared = channel ? isSlackConnectChannel(store, channel) : false;
  const author = typeof event.user === "string" ? ss.users.findOneBy("user_id", event.user) : undefined;
  return {
    type: "event_callback" as const,
    team_id: teamId,
    event_id: `Ev${randomUUID().replaceAll("-", "")}`,
    event_time: Math.floor(Date.now() / 1000),
    ...(channel ? { is_ext_shared_channel: shared } : {}),
    event:
      shared && event.type === "app_mention" && author && author.team_id !== teamId
        ? { ...event, user_team: author.team_id, source_team: author.team_id }
        : event,
  };
}

export function resolveSlackEventTeamId(c: Context, store: Store, fallbackTeamId?: string): string {
  const slackStore = getSlackStore(store);
  const token = c.get("authToken");
  const tokenTeamId = token ? slackStore.tokens.findOneBy("token", token)?.team_id : undefined;
  return tokenTeamId ?? fallbackTeamId ?? slackStore.teams.all()[0]?.team_id ?? "T000000001";
}
