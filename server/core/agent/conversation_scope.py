"""Conversation history scope is separate from the current speaker's memory identity."""
from dataclasses import dataclass


@dataclass(frozen=True)
class ConversationScope:
    platform: str
    kind: str
    owner: str
    channel: str

    @property
    def key(self):
        return self.platform, self.kind, self.owner, self.channel


def conversation_scope(owner, channel, discord_context=None):
    if discord_context is None:
        # Future application adapters may supply their own authenticated session channel.
        return ConversationScope("app", "private", owner, str(channel or ""))
    context = discord_context
    shared = context.guild is not None or context.channel.type in {"group", "group_dm"}
    if shared:
        guild = context.guild.id if context.guild else "group-dm"
        return ConversationScope("discord", "shared", "shared:discord:" + guild, context.channel.id)
    return ConversationScope("discord", "private", owner, context.channel.id)
