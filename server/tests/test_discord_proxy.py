import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from modules.discord.bot import NeyraDiscordBot


@pytest.mark.parametrize("configured,environment,expected", [
    (None, None, None),
    ("http://127.0.0.1:7890", None, "http://127.0.0.1:7890"),
    ("http://config.invalid:8080", " https://env.invalid:8443 ", "https://env.invalid:8443"),
    ("http://config.invalid:8080", " ", "http://config.invalid:8080"),
])
def test_discord_proxy_reaches_shared_rest_and_gateway_client(monkeypatch, configured, environment, expected):
    monkeypatch.delenv("DISCORD_PROXY_URL", raising=False)
    if environment is not None:
        monkeypatch.setenv("DISCORD_PROXY_URL", environment)

    async def run():
        bot = NeyraDiscordBot(SimpleNamespace(event_bus=Mock()), {"discord": {"proxy_url": configured}})
        assert bot.http.proxy == expected
        assert bot.allowed_mentions.to_dict() == {"parse": [], "replied_user": True}
        await bot.close()

    asyncio.run(run())


@pytest.mark.parametrize("url", ["socks5://localhost:1080", "http://", "http://localhost:bad", "http://localhost:0"])
def test_invalid_discord_proxy_is_rejected_without_echo(monkeypatch, url):
    monkeypatch.setenv("DISCORD_PROXY_URL", url)
    with pytest.raises(ValueError) as error:
        NeyraDiscordBot(SimpleNamespace(event_bus=Mock()), {})
    assert str(error.value) == "Discord proxy_url must be an HTTP(S) proxy URL"


def test_proxy_credentials_require_environment(monkeypatch):
    monkeypatch.delenv("DISCORD_PROXY_URL", raising=False)
    with pytest.raises(ValueError) as error:
        NeyraDiscordBot(SimpleNamespace(event_bus=Mock()), {"discord": {"proxy_url": "http://user:private@localhost:7890"}})
    assert str(error.value) == "Discord proxy credentials must be set via DISCORD_PROXY_URL in .env, not in YAML"


@pytest.mark.parametrize("userinfo", ["user:private", "user:p@ss", "user:p%40ss", "user"])
def test_environment_proxy_credentials_are_supported_and_redacted(monkeypatch, userinfo):
    from core.api.log_redaction import redact_text

    url = f"http://{userinfo}@localhost:7890"
    monkeypatch.setenv("DISCORD_PROXY_URL", url)

    async def run():
        bot = NeyraDiscordBot(SimpleNamespace(event_bus=Mock()), {})
        assert bot.http.proxy == url
        await bot.close()

    asyncio.run(run())
    assert redact_text("Proxy unavailable: " + url) == "Proxy unavailable: http://***@localhost:7890"
